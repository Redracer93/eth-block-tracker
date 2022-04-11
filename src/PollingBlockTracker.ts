import getCreateRandomId from 'json-rpc-random-id';
import pify from 'pify';
import {
  BaseBlockTracker,
  BaseBlockTrackerOptions,
  JsonRpcRequest,
  JsonRpcResponse,
  Provider,
} from './BaseBlockTracker';

const createRandomId = getCreateRandomId();
const sec = 1000;

export interface PollingBlockTrackerOptions extends BaseBlockTrackerOptions {
  pollingInterval?: number;
  retryTimeout?: number;
  keepEventLoopActive?: boolean;
  setSkipCacheFlag?: boolean;
  blockResetDuration?: number | undefined;
}

interface ExtendedJsonRpcRequest<T> extends JsonRpcRequest<T> {
  skipCache?: boolean;
}

export class PollingBlockTracker extends BaseBlockTracker {
  private _provider: Provider;

  private _pollingInterval: number;

  private _retryTimeout: number;

  private _keepEventLoopActive: boolean;

  private _setSkipCacheFlag: boolean;

  constructor(opts: PollingBlockTrackerOptions = {}) {
    if (!opts.provider) {
      throw new Error('PollingBlockTracker - no provider specified.');
    }

    super({
      blockResetDuration: opts.blockResetDuration ?? opts.pollingInterval,
    });

    // config
    this._provider = opts.provider;
    this._pollingInterval = opts.pollingInterval || 20 * sec;
    this._retryTimeout = opts.retryTimeout || this._pollingInterval / 10;
    this._keepEventLoopActive =
      opts.keepEventLoopActive === undefined ? true : opts.keepEventLoopActive;
    this._setSkipCacheFlag = opts.setSkipCacheFlag || false;
  }

  // trigger block polling
  async checkForLatestBlock() {
    await this._updateLatestBlock();
    return await this.getLatestBlock();
  }

  protected async _start(): Promise<void> {
    await super._start();
    await this._synchronize();
  }

  private async _synchronize(): Promise<void> {
    while (this._isRunning) {
      try {
        await this._updateLatestBlock();
        const promise = timeout(
          this._pollingInterval,
          !this._keepEventLoopActive,
        );
        this.emit('_waitingForNextIteration');
        await promise;
      } catch (error: any) {
        const newError = new Error(
          `PollingBlockTracker - encountered an error while attempting to update latest block:\n${
            error.stack ?? error.message ?? error
          }`,
        );
        this.emit('error', newError);
        await timeout(this._retryTimeout, !this._keepEventLoopActive);
      }
    }
  }

  private async _updateLatestBlock(): Promise<void> {
    // fetch + set latest block
    const latestBlock = await this._fetchLatestBlock();
    this._newPotentialLatest(latestBlock);
  }

  private async _fetchLatestBlock(): Promise<string> {
    const req = {
      jsonrpc: '2.0' as const,
      id: createRandomId(),
      method: 'eth_blockNumber' as const,
      params: [],
      ...(this._setSkipCacheFlag ? { skipCache: true } : {}),
    };

    const res: JsonRpcResponse<string> = await pify((cb) =>
      this._provider.sendAsync(req, cb),
    )();
    if ('error' in res) {
      throw new Error(
        `PollingBlockTracker - encountered error fetching block:\n${res.error.message}`,
      );
    }
    return res.result;
  }
}

/**
 * Waits for the specified amount of time.
 *
 * @param duration - The amount of time in milliseconds.
 * @param unref - Assuming this function is run in a Node context, governs
 * whether Node should wait before the `setTimeout` has completed before ending
 * the process (true for no, false for yes). Defaults to false.
 * @returns A promise that can be used to wait.
 */
function timeout(duration: number, unref: boolean) {
  return new Promise((resolve) => {
    const timeoutRef = setTimeout(resolve, duration);
    // don't keep process open
    if (timeoutRef.unref && unref) {
      timeoutRef.unref();
    }
  });
}