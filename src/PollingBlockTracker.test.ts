import EMPTY_FUNCTION from '../tests/emptyFunction';
import recordCallsToSetTimeout from '../tests/recordCallsToSetTimeout';
import withBlockTracker, {
  WithBlockTrackerCallback,
  WithBlockTrackerOptions,
} from '../tests/withBlockTracker';
import buildDeferred from '../tests/buildDeferred';
import { PollingBlockTracker } from '.';

interface Sync {
  oldBlock: string;
  newBlock: string;
}

const METHODS_TO_ADD_LISTENER = ['on', 'addListener'] as const;
const METHODS_TO_REMOVE_LISTENER = ['off', 'removeListener'] as const;

/**
 * Calls the given function with a built-in PollingBlockTracker, ensuring that
 * all listeners that are on the block tracker are removed and any timers or
 * loops that are running within the block tracker are properly stopped.
 *
 * @param options - Options that allow configuring the block tracker or
 *
 * provider.
 * @param callback - A callback which will be called with the built  * block
 * tracker.
 */
async function withPollingBlockTracker(
  options: WithBlockTrackerOptions<PollingBlockTracker>,
  callback: WithBlockTrackerCallback<PollingBlockTracker>,
): Promise<void>;
/**
 * Calls the given function with a built-in PollingBlockTracker, ensuring that
 * all listeners that are on the block tracker are removed and any timers or
 * loops that are running within the block tracker are properly stopped.
 *
 * @param callback - A callback which will be called with the built block
 * tracker.
 */
async function withPollingBlockTracker(
  callback: WithBlockTrackerCallback<PollingBlockTracker>,
): Promise<void>;
/* eslint-disable-next-line jsdoc/require-jsdoc */
async function withPollingBlockTracker(
  ...args: [...any[], WithBlockTrackerCallback<PollingBlockTracker>]
): Promise<void> {
  const callback: WithBlockTrackerCallback<PollingBlockTracker> = args.pop();
  const options =
    (args[0] as WithBlockTrackerOptions<PollingBlockTracker>) ?? {};
  await withBlockTracker<PollingBlockTracker>(
    PollingBlockTracker,
    options,
    callback,
  );
}

describe('PollingBlockTracker', () => {
  describe('constructor', () => {
    it('should throw if given no options', () => {
      expect(() => new PollingBlockTracker()).toThrow(
        'PollingBlockTracker - no provider specified.',
      );
    });

    it('should throw if given options but not given a provider', () => {
      expect(() => new PollingBlockTracker({})).toThrow(
        'PollingBlockTracker - no provider specified.',
      );
    });

    it('should return a block tracker that is not running', async () => {
      recordCallsToSetTimeout();

      await withPollingBlockTracker(({ blockTracker }) => {
        expect(blockTracker.isRunning()).toBe(false);
      });
    });
  });

  describe('destroy', () => {
    it('should stop the block tracker if any "latest" and "sync" events were added previously', async () => {
      recordCallsToSetTimeout();

      await withPollingBlockTracker(async ({ blockTracker }) => {
        await new Promise<void>((resolve) => {
          blockTracker.on('latest', resolve);
        });
        expect(blockTracker.isRunning()).toBe(true);

        await blockTracker.destroy();
        expect(blockTracker.isRunning()).toBe(false);
      });
    });

    it('should not clear the current block number cache if called after removing all listeners but before enough time passes that the cache would have been cleared', async () => {
      const setTimeoutRecorder = recordCallsToSetTimeout();
      const blockTrackerOptions = {
        pollingInterval: 100,
        blockResetDuration: 200,
      };

      await withPollingBlockTracker(
        {
          provider: {
            stubs: [
              {
                methodName: 'eth_blockNumber',
                response: {
                  result: '0x0',
                },
              },
            ],
          },
          blockTracker: blockTrackerOptions,
        },
        async ({ blockTracker }) => {
          blockTracker.on('latest', EMPTY_FUNCTION);
          blockTracker.on('sync', EMPTY_FUNCTION);
          await new Promise((resolve) => {
            blockTracker.on('_waitingForNextIteration', resolve);
          });
          expect(blockTracker.getCurrentBlock()).toStrictEqual('0x0');
          blockTracker.removeAllListeners();
          expect(setTimeoutRecorder.calls).toHaveLength(2);

          await blockTracker.destroy();

          expect(setTimeoutRecorder.calls).toHaveLength(1);
          expect(blockTracker.getCurrentBlock()).toStrictEqual('0x0');
        },
      );
    });
  });

  describe('getLatestBlock', () => {
    it('should start the block tracker immediately after being called', async () => {
      recordCallsToSetTimeout();

      await withPollingBlockTracker(async ({ blockTracker }) => {
        const promiseToGetLatestBlock = blockTracker.getLatestBlock();
        expect(blockTracker.isRunning()).toBe(true);
        // We have to wait for the promise to resolve after the assertion
        // because by the time this promise resolves, the block tracker isn't
        // running anymore
        await promiseToGetLatestBlock;
      });
    });

    it('should stop the block tracker automatically after its promise is fulfilled', async () => {
      recordCallsToSetTimeout();

      await withPollingBlockTracker(async ({ blockTracker }) => {
        await blockTracker.getLatestBlock();
        expect(blockTracker.isRunning()).toBe(false);
      });
    });

    it('should fetch the latest block number', async () => {
      recordCallsToSetTimeout();

      await withPollingBlockTracker(
        {
          provider: {
            stubs: [
              {
                methodName: 'eth_blockNumber',
                response: {
                  result: '0x0',
                },
              },
            ],
          },
        },
        async ({ blockTracker }) => {
          const latestBlockNumber = await blockTracker.getLatestBlock();
          expect(latestBlockNumber).toStrictEqual('0x0');
        },
      );
    });

    it('should cause the request to get the latest block to be made with `skipCache: true` if setSkipCacheFlag: true is given', async () => {
      recordCallsToSetTimeout();

      await withPollingBlockTracker(
        { blockTracker: { setSkipCacheFlag: true } },
        async ({ provider, blockTracker }) => {
          jest.spyOn(provider, 'sendAsync');

          await blockTracker.getLatestBlock();

          expect(provider.sendAsync).toHaveBeenCalledWith(
            {
              jsonrpc: '2.0' as const,
              id: expect.any(Number),
              method: 'eth_blockNumber' as const,
              params: [],
              skipCache: true,
            },
            expect.any(Function),
          );
        },
      );
    });

    it('should not cause the block tracker to make a request for the latest block number more than once when called more than once while the current block number cache is still fresh', async () => {
      recordCallsToSetTimeout();

      await withPollingBlockTracker(async ({ provider, blockTracker }) => {
        const sendAsyncSpy = jest.spyOn(provider, 'sendAsync');
        await blockTracker.getLatestBlock();
        await blockTracker.getLatestBlock();
        const requestsForLatestBlock = sendAsyncSpy.mock.calls.filter(
          (args) => {
            return args[0].method === 'eth_blockNumber';
          },
        );
        expect(requestsForLatestBlock).toHaveLength(1);
      });
    });

    it('should cause the block tracker to make a request for the latest block number again if called again after the current block number cache becomes stale', async () => {
      const setTimeoutRecorder = recordCallsToSetTimeout();
      const blockTrackerOptions = {
        pollingInterval: 100,
        blockResetDuration: 200,
      };

      await withPollingBlockTracker(
        {
          provider: {
            stubs: [
              {
                methodName: 'eth_blockNumber',
                response: {
                  result: '0x0',
                },
              },
              {
                methodName: 'eth_blockNumber',
                response: {
                  result: '0x1',
                },
              },
            ],
          },
          blockTracker: blockTrackerOptions,
        },
        async ({ provider, blockTracker }) => {
          const sendAsyncSpy = jest.spyOn(provider, 'sendAsync');
          await blockTracker.getLatestBlock();
          // When the block tracker stops, there may be two `setTimeout`s in
          // play: one to go to the next iteration of the block tracker
          // loop, another to expire the current block number cache. We don't
          // know which one has been added first, so we have to find it.
          await setTimeoutRecorder.nextMatchingDuration(
            blockTrackerOptions.blockResetDuration,
          );
          await blockTracker.getLatestBlock();
          const requestsForLatestBlock = sendAsyncSpy.mock.calls.filter(
            (args) => {
              return args[0].method === 'eth_blockNumber';
            },
          );
          expect(requestsForLatestBlock).toHaveLength(2);
        },
      );
    });

    METHODS_TO_ADD_LISTENER.forEach((methodToAddListener) => {
      it(`should emit the "error" event (added via \`${methodToAddListener}\`) and should not throw if the request for the latest block number returns an error response`, async () => {
        recordCallsToSetTimeout({ numAutomaticCalls: 1 });

        await withPollingBlockTracker(
          {
            provider: {
              stubs: [
                {
                  methodName: 'eth_blockNumber',
                  response: {
                    error: 'boom',
                  },
                },
                {
                  methodName: 'eth_blockNumber',
                  response: {
                    result: '0x0',
                  },
                },
              ],
            },
          },
          async ({ blockTracker }) => {
            const promiseForCaughtError = new Promise<any>((resolve) => {
              blockTracker[methodToAddListener]('error', resolve);
            });

            const promiseForLatestBlock = blockTracker.getLatestBlock();

            const caughtError = await promiseForCaughtError;
            expect(caughtError.message).toMatch(
              /^PollingBlockTracker - encountered an error while attempting to update latest block:\nError: PollingBlockTracker - encountered error fetching block:\nboom\n/u,
            );
            const latestBlock = await promiseForLatestBlock;
            expect(latestBlock).toStrictEqual('0x0');
          },
        );
      });

      it(`should emit the "error" event (added via \`${methodToAddListener}\`) and should not throw if, while making the request for the latest block number, the provider throws an error that is an Error`, async () => {
        recordCallsToSetTimeout({ numAutomaticCalls: 1 });

        await withPollingBlockTracker(
          {
            provider: {
              stubs: [
                {
                  methodName: 'eth_blockNumber',
                  implementation: () => {
                    throw new Error('boom');
                  },
                },
                {
                  methodName: 'eth_blockNumber',
                  response: {
                    result: '0x0',
                  },
                },
              ],
            },
          },
          async ({ blockTracker }) => {
            const promiseForCaughtError = new Promise<any>((resolve) => {
              blockTracker[methodToAddListener]('error', resolve);
            });

            const promiseForLatestBlock = blockTracker.getLatestBlock();

            const caughtError = await promiseForCaughtError;
            expect(caughtError.message).toMatch(
              /^PollingBlockTracker - encountered an error while attempting to update latest block:\nError: boom\n/u,
            );
            const latestBlock = await promiseForLatestBlock;
            expect(latestBlock).toStrictEqual('0x0');
          },
        );
      });

      it(`should emit the "error" event (added via \`${methodToAddListener}\`) and should not throw if, while making the request for the latest block number, the provider throws an error that is a string`, async () => {
        recordCallsToSetTimeout({ numAutomaticCalls: 1 });

        await withPollingBlockTracker(
          {
            provider: {
              stubs: [
                {
                  methodName: 'eth_blockNumber',
                  implementation: () => {
                    throw 'boom';
                  },
                },
                {
                  methodName: 'eth_blockNumber',
                  response: {
                    result: '0x0',
                  },
                },
              ],
            },
          },
          async ({ blockTracker }) => {
            const promiseForCaughtError = new Promise<any>((resolve) => {
              blockTracker[methodToAddListener]('error', resolve);
            });

            const promiseForLatestBlock = blockTracker.getLatestBlock();

            const caughtError = await promiseForCaughtError;
            expect(caughtError.message).toMatch(
              /^PollingBlockTracker - encountered an error while attempting to update latest block:\nboom/u,
            );
            const latestBlock = await promiseForLatestBlock;
            expect(latestBlock).toStrictEqual('0x0');
          },
        );
      });

      it(`should emit the "error" event (added via \`${methodToAddListener}\`) and should not throw if, while making the request for the latest block number, the provider rejects with an error`, async () => {
        recordCallsToSetTimeout({ numAutomaticCalls: 1 });

        await withPollingBlockTracker(
          {
            provider: {
              stubs: [
                {
                  methodName: 'eth_blockNumber',
                  error: 'boom',
                },
                {
                  methodName: 'eth_blockNumber',
                  response: {
                    result: '0x0',
                  },
                },
              ],
            },
          },
          async ({ blockTracker }) => {
            const promiseForCaughtError = new Promise<any>((resolve) => {
              blockTracker[methodToAddListener]('error', resolve);
            });

            const promiseForLatestBlock = await blockTracker.getLatestBlock();

            const caughtError = await promiseForCaughtError;
            expect(caughtError.message).toMatch(
              /^PollingBlockTracker - encountered an error while attempting to update latest block:\nError: boom/u,
            );
            const latestBlock = await promiseForLatestBlock;
            expect(latestBlock).toStrictEqual('0x0');
          },
        );
      });
    });

    it('should update the current block number', async () => {
      recordCallsToSetTimeout();

      await withPollingBlockTracker(
        {
          provider: {
            stubs: [
              {
                methodName: 'eth_blockNumber',
                response: {
                  result: '0x0',
                },
              },
            ],
          },
        },
        async ({ blockTracker }) => {
          await blockTracker.getLatestBlock();
          const currentBlockNumber = blockTracker.getCurrentBlock();
          expect(currentBlockNumber).toStrictEqual('0x0');
        },
      );
    });

    it('should clear the current block number some time after being called', async () => {
      const setTimeoutRecorder = recordCallsToSetTimeout();
      const blockTrackerOptions = {
        pollingInterval: 100,
        blockResetDuration: 200,
      };

      await withPollingBlockTracker(
        {
          provider: {
            stubs: [
              {
                methodName: 'eth_blockNumber',
                response: {
                  result: '0x0',
                },
              },
            ],
          },
          blockTracker: blockTrackerOptions,
        },
        async ({ blockTracker }) => {
          await blockTracker.getLatestBlock();
          const currentBlockNumber = blockTracker.getCurrentBlock();
          expect(currentBlockNumber).toStrictEqual('0x0');

          // When the block tracker stops, there may be two `setTimeout`s in
          // play: one to go to the next iteration of the block tracker
          // loop, another to expire the current block number cache. We don't
          // know which one has been added first, so we have to find it.
          await setTimeoutRecorder.nextMatchingDuration(
            blockTrackerOptions.blockResetDuration,
          );
          expect(blockTracker.getCurrentBlock()).toBeNull();
        },
      );
    });
  });

  describe('checkForLatestBlock', () => {
    it('should start the block tracker shortly after being called', async () => {
      recordCallsToSetTimeout();

      await withPollingBlockTracker(
        {
          provider: {
            stubs: [
              {
                methodName: 'eth_blockNumber',
                response: {
                  result: '0x0',
                },
              },
              {
                methodName: 'eth_blockNumber',
                response: {
                  result: '0x1',
                },
              },
            ],
          },
        },
        async ({ blockTracker }) => {
          blockTracker.checkForLatestBlock();
          await new Promise((resolve) => {
            blockTracker.on('latest', resolve);
          });
          expect(blockTracker.isRunning()).toBe(true);
        },
      );
    });

    it('should stop the block tracker automatically after its promise is fulfilled', async () => {
      recordCallsToSetTimeout();

      await withPollingBlockTracker(async ({ blockTracker }) => {
        await blockTracker.checkForLatestBlock();
        expect(blockTracker.isRunning()).toBe(false);
      });
    });

    it('should fetch the latest block number', async () => {
      recordCallsToSetTimeout();

      await withPollingBlockTracker(
        {
          provider: {
            stubs: [
              {
                methodName: 'eth_blockNumber',
                response: {
                  result: '0x0',
                },
              },
            ],
          },
        },
        async ({ blockTracker }) => {
          const latestBlockNumber = await blockTracker.checkForLatestBlock();
          expect(latestBlockNumber).toStrictEqual('0x0');
        },
      );
    });

    it('should cause the request to get the latest block to be made with `skipCache: true` if setSkipCacheFlag: true is given', async () => {
      recordCallsToSetTimeout();

      await withPollingBlockTracker(
        { blockTracker: { setSkipCacheFlag: true } },
        async ({ provider, blockTracker }) => {
          jest.spyOn(provider, 'sendAsync');

          await blockTracker.checkForLatestBlock();

          expect(provider.sendAsync).toHaveBeenCalledWith(
            {
              jsonrpc: '2.0' as const,
              id: expect.any(Number),
              method: 'eth_blockNumber' as const,
              params: [],
              skipCache: true,
            },
            expect.any(Function),
          );
        },
      );
    });

    METHODS_TO_ADD_LISTENER.forEach((methodToAddListener) => {
      it(`should not emit the "error" event (added via \`${methodToAddListener}\`), but should throw instead, if the request for the latest block number returns an error response`, async () => {
        recordCallsToSetTimeout({ numAutomaticCalls: 1 });

        await withPollingBlockTracker(
          {
            provider: {
              stubs: [
                {
                  methodName: 'eth_blockNumber',
                  response: {
                    error: 'boom',
                  },
                },
                {
                  methodName: 'eth_blockNumber',
                  response: {
                    result: '0x0',
                  },
                },
              ],
            },
          },
          async ({ blockTracker }) => {
            const promiseForLatestBlock = blockTracker.checkForLatestBlock();
            await expect(promiseForLatestBlock).rejects.toThrow(
              /^PollingBlockTracker - encountered error fetching block:\nboom/u,
            );
          },
        );
      });

      it(`should not emit the "error" event (added via \`${methodToAddListener}\`), but should throw instead, if, while making the request for the latest block number, the provider throws an error`, async () => {
        recordCallsToSetTimeout({ numAutomaticCalls: 1 });
        const thrownError = new Error('boom');

        await withPollingBlockTracker(
          {
            provider: {
              stubs: [
                {
                  methodName: 'eth_blockNumber',
                  implementation: () => {
                    throw thrownError;
                  },
                },
                {
                  methodName: 'eth_blockNumber',
                  response: {
                    result: '0x0',
                  },
                },
              ],
            },
          },
          async ({ blockTracker }) => {
            const promiseForLatestBlock = blockTracker.checkForLatestBlock();
            await expect(promiseForLatestBlock).rejects.toThrow(thrownError);
          },
        );
      });

      it(`should not emit the "error" event (added via \`${methodToAddListener}\`), but should throw instead, if, while making the request for the latest block number, the provider rejects with an error`, async () => {
        recordCallsToSetTimeout({ numAutomaticCalls: 1 });
        const thrownError = new Error('boom');

        await withPollingBlockTracker(
          {
            provider: {
              stubs: [
                {
                  methodName: 'eth_blockNumber',
                  error: 'boom',
                },
                {
                  methodName: 'eth_blockNumber',
                  response: {
                    result: '0x0',
                  },
                },
              ],
            },
          },
          async ({ blockTracker }) => {
            const promiseForLatestBlock = blockTracker.checkForLatestBlock();
            await expect(promiseForLatestBlock).rejects.toThrow(thrownError);
          },
        );
      });
    });

    it('should update the current block number', async () => {
      recordCallsToSetTimeout();

      await withPollingBlockTracker(
        {
          provider: {
            stubs: [
              {
                methodName: 'eth_blockNumber',
                response: {
                  result: '0x0',
                },
              },
            ],
          },
        },
        async ({ blockTracker }) => {
          await blockTracker.checkForLatestBlock();
          const currentBlockNumber = blockTracker.getCurrentBlock();
          expect(currentBlockNumber).toStrictEqual('0x0');
        },
      );
    });

    it('should never clear the current block number later', async () => {
      recordCallsToSetTimeout({ numAutomaticCalls: 1 });
      const blockTrackerOptions = {
        pollingInterval: 100,
        blockResetDuration: 200,
      };

      await withPollingBlockTracker(
        {
          provider: {
            stubs: [
              {
                methodName: 'eth_blockNumber',
                response: {
                  result: '0x0',
                },
              },
            ],
          },
          blockTracker: blockTrackerOptions,
        },
        async ({ blockTracker }) => {
          await blockTracker.checkForLatestBlock();
          const currentBlockNumber = blockTracker.getCurrentBlock();
          expect(currentBlockNumber).toStrictEqual('0x0');
        },
      );
    });
  });

  METHODS_TO_ADD_LISTENER.forEach((methodToAddListener) => {
    describe(`${methodToAddListener}`, () => {
      describe('"latest"', () => {
        it('should start the block tracker', async () => {
          recordCallsToSetTimeout();

          await withPollingBlockTracker(({ blockTracker }) => {
            blockTracker[methodToAddListener]('latest', EMPTY_FUNCTION);

            expect(blockTracker.isRunning()).toBe(true);
          });
        });

        it('should take a listener that is called soon after being added', async () => {
          recordCallsToSetTimeout();

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const latestBlockNumber = await new Promise<string>((resolve) => {
                blockTracker[methodToAddListener]('latest', resolve);
              });
              expect(latestBlockNumber).toStrictEqual('0x0');
            },
          );
        });

        it('should take a listener that is called periodically after being added', async () => {
          const setTimeoutRecorder = recordCallsToSetTimeout({
            numAutomaticCalls: 1,
          });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x1',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const receivedBlockNumbers: string[] = [];

              await new Promise<void>((resolve) => {
                setTimeoutRecorder.onNumAutomaticCallsExhausted(resolve);

                blockTracker[methodToAddListener](
                  'latest',
                  (blockNumber: string) => {
                    receivedBlockNumbers.push(blockNumber);
                  },
                );
              });

              expect(receivedBlockNumbers).toStrictEqual(['0x0', '0x1']);
            },
          );
        });

        it('should change the Timeout object created when the poll loop waits for the next iteration such that Node does not have to wait for it to finish before exiting', async () => {
          const setTimeoutRecorder = recordCallsToSetTimeout();
          const blockTrackerOptions = {
            pollingInterval: 100,
            blockResetDuration: 200,
            keepEventLoopActive: false,
          };

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x1',
                    },
                  },
                ],
              },
              blockTracker: blockTrackerOptions,
            },
            async ({ blockTracker }) => {
              blockTracker[methodToAddListener]('latest', EMPTY_FUNCTION);

              await new Promise((resolve) => {
                blockTracker.on('_waitingForNextIteration', resolve);
              });

              const nextIterationTimeout = setTimeoutRecorder.calls.find(
                (call) => {
                  return call.duration === blockTrackerOptions.pollingInterval;
                },
              );
              expect(nextIterationTimeout).not.toBeUndefined();
              expect(nextIterationTimeout?.timeout.hasRef()).toBe(false);
            },
          );
        });

        it('should take a listener that is not called after the latest block is fetched if the new block number is less than the current block number', async () => {
          const setTimeoutRecorder = recordCallsToSetTimeout({
            numAutomaticCalls: 1,
          });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x1',
                    },
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const receivedBlockNumbers: string[] = [];

              await new Promise<void>((resolve) => {
                setTimeoutRecorder.onNumAutomaticCallsExhausted(resolve);

                blockTracker[methodToAddListener](
                  'latest',
                  (blockNumber: string) => {
                    receivedBlockNumbers.push(blockNumber);
                  },
                );
              });

              expect(receivedBlockNumbers).toStrictEqual(['0x1']);
            },
          );
        });

        it('should take a listener that, if it throws an error, causes that error to be re-thrown eventually out-of-band', async () => {
          await withPollingBlockTracker(async ({ blockTracker }) => {
            const thrownError = new Error('boom');
            const promiseForCaughtError = new Promise<unknown>((resolve) => {
              recordCallsToSetTimeout({
                numAutomaticCalls: 2,
                interceptCallback: (callback, stopPassingThroughCalls) => {
                  return async () => {
                    try {
                      await callback();
                    } catch (error: unknown) {
                      resolve(error);
                      stopPassingThroughCalls();
                    }
                  };
                },
              });
            });

            blockTracker[methodToAddListener]('latest', () => {
              throw thrownError;
            });

            const caughtError = await promiseForCaughtError;
            expect(caughtError).toBe(thrownError);
          });
        });

        it('causes the request to get the latest block to be made with `skipCache: true` if the block tracker was initialized with setSkipCacheFlag: true', async () => {
          recordCallsToSetTimeout();

          await withPollingBlockTracker(
            { blockTracker: { setSkipCacheFlag: true } },
            async ({ provider, blockTracker }) => {
              jest.spyOn(provider, 'sendAsync');

              await new Promise((resolve) => {
                blockTracker[methodToAddListener]('latest', resolve);
              });

              expect(provider.sendAsync).toHaveBeenCalledWith(
                {
                  jsonrpc: '2.0' as const,
                  id: expect.any(Number),
                  method: 'eth_blockNumber' as const,
                  params: [],
                  skipCache: true,
                },
                expect.any(Function),
              );
            },
          );
        });

        it(`should emit the "error" event and should not kill the block tracker if the request for the latest block number returns an error response`, async () => {
          recordCallsToSetTimeout({ numAutomaticCalls: 1 });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      error: 'boom',
                    },
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const promiseForCaughtError = new Promise<any>((resolve) => {
                blockTracker[methodToAddListener]('error', resolve);
              });

              const promiseForLatestBlock = new Promise((resolve) => {
                blockTracker[methodToAddListener]('latest', resolve);
              });

              const caughtError = await promiseForCaughtError;
              expect(caughtError.message).toMatch(
                /^PollingBlockTracker - encountered an error while attempting to update latest block:\nError: PollingBlockTracker - encountered error fetching block:\nboom\n/u,
              );
              const latestBlock = await promiseForLatestBlock;
              expect(latestBlock).toStrictEqual('0x0');
            },
          );
        });

        it(`should emit the "error" event and should not kill the block tracker if, while making the request for the latest block number, the provider throws an error`, async () => {
          recordCallsToSetTimeout({ numAutomaticCalls: 1 });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    implementation: () => {
                      throw new Error('boom');
                    },
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const promiseForCaughtError = new Promise<any>((resolve) => {
                blockTracker[methodToAddListener]('error', resolve);
              });

              const promiseForLatestBlock = new Promise((resolve) => {
                blockTracker[methodToAddListener]('latest', resolve);
              });

              const caughtError = await promiseForCaughtError;
              expect(caughtError.message).toMatch(
                /^PollingBlockTracker - encountered an error while attempting to update latest block:\nError: boom\n/u,
              );
              const latestBlock = await promiseForLatestBlock;
              expect(latestBlock).toStrictEqual('0x0');
            },
          );
        });

        it(`should emit the "error" event and should not kill the block tracker if, while making the request for the latest block number, the provider rejects with an error`, async () => {
          recordCallsToSetTimeout({ numAutomaticCalls: 1 });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    error: 'boom',
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const promiseForCaughtError = new Promise<any>((resolve) => {
                blockTracker[methodToAddListener]('error', resolve);
              });

              const promiseForLatestBlock = new Promise((resolve) => {
                blockTracker[methodToAddListener]('latest', resolve);
              });

              const caughtError = await promiseForCaughtError;
              expect(caughtError.message).toMatch(
                /^PollingBlockTracker - encountered an error while attempting to update latest block:\nError: boom/u,
              );
              const latestBlock = await promiseForLatestBlock;
              expect(latestBlock).toStrictEqual('0x0');
            },
          );
        });

        it('should update the current block number', async () => {
          recordCallsToSetTimeout();

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              await new Promise((resolve) => {
                blockTracker[methodToAddListener]('latest', resolve);
              });
              const currentBlockNumber = blockTracker.getCurrentBlock();
              expect(currentBlockNumber).toStrictEqual('0x0');
            },
          );
        });
      });

      describe('"sync"', () => {
        it('should start the block tracker', async () => {
          recordCallsToSetTimeout();

          await withPollingBlockTracker(({ blockTracker }) => {
            blockTracker[methodToAddListener]('sync', EMPTY_FUNCTION);

            expect(blockTracker.isRunning()).toBe(true);
          });
        });

        it('should take a listener that is called soon after being added', async () => {
          recordCallsToSetTimeout();

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const sync = await new Promise<Sync>((resolve) => {
                blockTracker[methodToAddListener]('sync', resolve);
              });
              expect(sync).toStrictEqual({ oldBlock: null, newBlock: '0x0' });
            },
          );
        });

        it('should take a listener that is called periodically after being added', async () => {
          const setTimeoutRecorder = recordCallsToSetTimeout({
            numAutomaticCalls: 1,
          });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x1',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const syncs: Sync[] = [];

              await new Promise<void>((resolve) => {
                setTimeoutRecorder.onNumAutomaticCallsExhausted(resolve);

                blockTracker[methodToAddListener]('sync', (sync: Sync) => {
                  syncs.push(sync);
                });
              });

              expect(syncs).toStrictEqual([
                { oldBlock: null, newBlock: '0x0' },
                { oldBlock: '0x0', newBlock: '0x1' },
              ]);
            },
          );
        });

        it('should change the Timeout object created when the poll loop waits for the next iteration such that Node does not have to wait for it to finish before exiting', async () => {
          const setTimeoutRecorder = recordCallsToSetTimeout();
          const blockTrackerOptions = {
            pollingInterval: 100,
            blockResetDuration: 200,
            keepEventLoopActive: false,
          };

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x1',
                    },
                  },
                ],
              },
              blockTracker: blockTrackerOptions,
            },
            async ({ blockTracker }) => {
              blockTracker[methodToAddListener]('sync', EMPTY_FUNCTION);

              await new Promise((resolve) => {
                blockTracker.on('_waitingForNextIteration', resolve);
              });

              const nextIterationTimeout = setTimeoutRecorder.calls.find(
                (call) => {
                  return call.duration === blockTrackerOptions.pollingInterval;
                },
              );
              expect(nextIterationTimeout).not.toBeUndefined();
              expect(nextIterationTimeout?.timeout.hasRef()).toBe(false);
            },
          );
        });

        it('should take a listener that is not called after the latest block is fetched if the new block number is less than the current block number', async () => {
          const setTimeoutRecorder = recordCallsToSetTimeout({
            numAutomaticCalls: 1,
          });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x1',
                    },
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const syncs: Sync[] = [];

              await new Promise<void>((resolve) => {
                setTimeoutRecorder.onNumAutomaticCallsExhausted(resolve);

                blockTracker[methodToAddListener]('sync', (sync: Sync) => {
                  syncs.push(sync);
                });
              });

              expect(syncs).toStrictEqual([
                { oldBlock: null, newBlock: '0x1' },
              ]);
            },
          );
        });

        it('should take a listener that, if it throws an error, causes that error to be re-thrown eventually out-of-band', async () => {
          await withPollingBlockTracker(async ({ blockTracker }) => {
            const thrownError = new Error('boom');
            const promiseForCaughtError = new Promise<unknown>((resolve) => {
              recordCallsToSetTimeout({
                numAutomaticCalls: 2,
                interceptCallback: (callback, stopPassingThroughCalls) => {
                  return async () => {
                    try {
                      await callback();
                    } catch (error: unknown) {
                      resolve(error);
                      stopPassingThroughCalls();
                    }
                  };
                },
              });
            });

            blockTracker[methodToAddListener]('sync', () => {
              throw thrownError;
            });

            const caughtError = await promiseForCaughtError;
            expect(caughtError).toBe(thrownError);
          });
        });

        it('causes the request to get the latest block to be made with `skipCache: true` if the block tracker was initialized with setSkipCacheFlag: true', async () => {
          recordCallsToSetTimeout();

          await withPollingBlockTracker(
            { blockTracker: { setSkipCacheFlag: true } },
            async ({ provider, blockTracker }) => {
              jest.spyOn(provider, 'sendAsync');

              await new Promise((resolve) => {
                blockTracker[methodToAddListener]('sync', resolve);
              });

              expect(provider.sendAsync).toHaveBeenCalledWith(
                {
                  jsonrpc: '2.0' as const,
                  id: expect.any(Number),
                  method: 'eth_blockNumber' as const,
                  params: [],
                  skipCache: true,
                },
                expect.any(Function),
              );
            },
          );
        });

        it(`should emit the "error" event and should not kill the block tracker if the request for the latest block number returns an error response`, async () => {
          recordCallsToSetTimeout({ numAutomaticCalls: 1 });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      error: 'boom',
                    },
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const promiseForCaughtError = new Promise<any>((resolve) => {
                blockTracker[methodToAddListener]('error', resolve);
              });

              const promiseForLatestBlock = new Promise((resolve) => {
                blockTracker[methodToAddListener]('latest', resolve);
              });

              const caughtError = await promiseForCaughtError;
              expect(caughtError.message).toMatch(
                /^PollingBlockTracker - encountered an error while attempting to update latest block:\nError: PollingBlockTracker - encountered error fetching block:\nboom\n/u,
              );
              const latestBlock = await promiseForLatestBlock;
              expect(latestBlock).toStrictEqual('0x0');
            },
          );
        });

        it(`should emit the "error" event and should not kill the block tracker if, while making the request for the latest block number, the provider throws an error that is an Error`, async () => {
          recordCallsToSetTimeout({ numAutomaticCalls: 1 });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    implementation: () => {
                      throw new Error('boom');
                    },
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const promiseForCaughtError = new Promise<any>((resolve) => {
                blockTracker[methodToAddListener]('error', resolve);
              });

              const promiseForLatestBlock = new Promise((resolve) => {
                blockTracker[methodToAddListener]('latest', resolve);
              });

              const caughtError = await promiseForCaughtError;
              expect(caughtError.message).toMatch(
                /^PollingBlockTracker - encountered an error while attempting to update latest block:\nError: boom\n/u,
              );
              const latestBlock = await promiseForLatestBlock;
              expect(latestBlock).toStrictEqual('0x0');
            },
          );
        });

        it(`should emit the "error" event and should not kill the block tracker if, while making the request for the latest block number, the provider throws an error that is a string`, async () => {
          recordCallsToSetTimeout({ numAutomaticCalls: 1 });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    implementation: () => {
                      throw 'boom';
                    },
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const promiseForCaughtError = new Promise<any>((resolve) => {
                blockTracker[methodToAddListener]('error', resolve);
              });

              const promiseForLatestBlock = new Promise((resolve) => {
                blockTracker[methodToAddListener]('latest', resolve);
              });

              const caughtError = await promiseForCaughtError;
              expect(caughtError.message).toMatch(
                /^PollingBlockTracker - encountered an error while attempting to update latest block:\nboom/u,
              );
              const latestBlock = await promiseForLatestBlock;
              expect(latestBlock).toStrictEqual('0x0');
            },
          );
        });

        it(`should emit the "error" event and should not kill the block tracker if, while making the request for the latest block number, the provider rejects with an error`, async () => {
          recordCallsToSetTimeout({ numAutomaticCalls: 1 });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    error: 'boom',
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const promiseForCaughtError = new Promise<any>((resolve) => {
                blockTracker[methodToAddListener]('error', resolve);
              });

              const promiseForLatestBlock = new Promise((resolve) => {
                blockTracker[methodToAddListener]('latest', resolve);
              });

              const caughtError = await promiseForCaughtError;
              expect(caughtError.message).toMatch(
                /^PollingBlockTracker - encountered an error while attempting to update latest block:\nError: boom/u,
              );
              const latestBlock = await promiseForLatestBlock;
              expect(latestBlock).toStrictEqual('0x0');
            },
          );
        });

        it('should update the current block number', async () => {
          recordCallsToSetTimeout();

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              await new Promise((resolve) => {
                blockTracker[methodToAddListener]('sync', resolve);
              });
              const currentBlockNumber = blockTracker.getCurrentBlock();
              expect(currentBlockNumber).toStrictEqual('0x0');
            },
          );
        });
      });

      describe('some other event', () => {
        it('should not start the block tracker', async () => {
          recordCallsToSetTimeout();

          await withPollingBlockTracker(({ blockTracker }) => {
            blockTracker[methodToAddListener]('somethingElse', EMPTY_FUNCTION);

            expect(blockTracker.isRunning()).toBe(false);
          });
        });

        it('should not update the current block number', async () => {
          recordCallsToSetTimeout();

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              blockTracker[methodToAddListener](
                'somethingElse',
                EMPTY_FUNCTION,
              );
              const currentBlockNumber = blockTracker.getCurrentBlock();
              expect(currentBlockNumber).toBeNull();
            },
          );
        });
      });
    });
  });

  METHODS_TO_REMOVE_LISTENER.forEach((methodToRemoveListener) => {
    describe(`${methodToRemoveListener}`, () => {
      describe('"latest"', () => {
        it('should stop the block tracker if the last instance of this event is removed', async () => {
          recordCallsToSetTimeout();

          await withPollingBlockTracker(async ({ blockTracker }) => {
            const listener1 = EMPTY_FUNCTION;
            const { promise: promiseForLatest, resolve: listener2 } =
              buildDeferred();

            blockTracker.on('latest', listener1);
            blockTracker.on('latest', listener2);
            expect(blockTracker.isRunning()).toBe(true);

            await promiseForLatest;

            blockTracker[methodToRemoveListener]('latest', listener1);
            blockTracker[methodToRemoveListener]('latest', listener2);
            expect(blockTracker.isRunning()).toBe(false);
          });
        });

        it('should clear the current block number some time after the last instance of this event is removed', async () => {
          const setTimeoutRecorder = recordCallsToSetTimeout();
          const blockTrackerOptions = {
            pollingInterval: 100,
            blockResetDuration: 200,
          };

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
              blockTracker: blockTrackerOptions,
            },
            async ({ blockTracker }) => {
              const listener1 = EMPTY_FUNCTION;
              const { promise: promiseForLatest, resolve: listener2 } =
                buildDeferred();

              blockTracker.on('latest', listener1);
              blockTracker.on('latest', listener2);
              await promiseForLatest;
              const currentBlockNumber = blockTracker.getCurrentBlock();
              expect(currentBlockNumber).toStrictEqual('0x0');

              blockTracker[methodToRemoveListener]('latest', listener1);
              blockTracker[methodToRemoveListener]('latest', listener2);
              // When the block tracker stops, there may be two `setTimeout`s in
              // play: one to go to the next iteration of the block tracker
              // loop, another to expire the current block number cache. We
              // don't know which one has been added first, so we have to find
              // it.
              await setTimeoutRecorder.nextMatchingDuration(
                blockTrackerOptions.blockResetDuration,
              );
              expect(blockTracker.getCurrentBlock()).toBeNull();
            },
          );
        });
      });

      describe('"sync"', () => {
        it('should stop the block tracker if the last instance of this event is removed', async () => {
          recordCallsToSetTimeout();

          await withPollingBlockTracker(async ({ blockTracker }) => {
            const listener1 = EMPTY_FUNCTION;
            const { promise: promiseForLatest, resolve: listener2 } =
              buildDeferred();

            blockTracker.on('sync', listener1);
            blockTracker.on('sync', listener2);
            expect(blockTracker.isRunning()).toBe(true);

            await promiseForLatest;

            blockTracker[methodToRemoveListener]('sync', listener1);
            blockTracker[methodToRemoveListener]('sync', listener2);
            expect(blockTracker.isRunning()).toBe(false);
          });
        });

        it('should clear the current block number some time after the last instance of this event is removed', async () => {
          const setTimeoutRecorder = recordCallsToSetTimeout();
          const blockTrackerOptions = {
            pollingInterval: 100,
            blockResetDuration: 200,
          };

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
              blockTracker: blockTrackerOptions,
            },
            async ({ blockTracker }) => {
              const listener1 = EMPTY_FUNCTION;
              const { promise: promiseForLatest, resolve: listener2 } =
                buildDeferred();

              blockTracker.on('sync', listener1);
              blockTracker.on('sync', listener2);
              await promiseForLatest;
              const currentBlockNumber = blockTracker.getCurrentBlock();
              expect(currentBlockNumber).toStrictEqual('0x0');

              blockTracker[methodToRemoveListener]('sync', listener1);
              blockTracker[methodToRemoveListener]('sync', listener2);
              // When the block tracker stops, there may be two `setTimeout`s in
              // play: one to go to the next iteration of the block tracker
              // loop, another to expire the current block number cache. We
              // don't know which one has been added first, so we have to find
              // it.
              await setTimeoutRecorder.nextMatchingDuration(
                blockTrackerOptions.blockResetDuration,
              );
              expect(blockTracker.getCurrentBlock()).toBeNull();
            },
          );
        });
      });

      describe('some other event', () => {
        it('should not stop the block tracker', async () => {
          recordCallsToSetTimeout();

          await withPollingBlockTracker(async ({ blockTracker }) => {
            const { promise: promiseForLatest, resolve: listener1 } =
              buildDeferred();
            const listener2 = EMPTY_FUNCTION;

            blockTracker.on('latest', listener1);
            blockTracker.on('somethingElse', listener2);
            expect(blockTracker.isRunning()).toBe(true);

            await promiseForLatest;

            blockTracker[methodToRemoveListener]('somethingElse', listener2);
            expect(blockTracker.isRunning()).toBe(true);
          });
        });
      });
    });
  });

  describe('once', () => {
    describe('"latest"', () => {
      it('should start and then stop the block tracker automatically', async () => {
        // We stub 2 calls because PollingBlockTracker#_synchronize will make a
        // call (to proceed to the next iteration) and BaseBlockTracker will
        // make a call (to reset the current block number when the tracker is
        // not running)
        recordCallsToSetTimeout({ numAutomaticCalls: 2 });

        await withPollingBlockTracker(async ({ blockTracker }) => {
          await new Promise((resolve) => {
            blockTracker.on('_ended', resolve);
            blockTracker.once('latest', EMPTY_FUNCTION);
          });

          expect(blockTracker.isRunning()).toBe(false);
        });
      });

      it('should change the Timeout object created when the poll loop waits for the next iteration such that Node does not have to wait for it to finish before exiting', async () => {
        const setTimeoutRecorder = recordCallsToSetTimeout();
        const blockTrackerOptions = {
          pollingInterval: 100,
          blockResetDuration: 200,
          keepEventLoopActive: false,
        };

        await withPollingBlockTracker(
          {
            provider: {
              stubs: [
                {
                  methodName: 'eth_blockNumber',
                  response: {
                    result: '0x0',
                  },
                },
                {
                  methodName: 'eth_blockNumber',
                  response: {
                    result: '0x1',
                  },
                },
              ],
            },
            blockTracker: blockTrackerOptions,
          },
          async ({ blockTracker }) => {
            blockTracker.once('latest', EMPTY_FUNCTION);

            await new Promise((resolve) => {
              blockTracker.on('_waitingForNextIteration', resolve);
            });

            const nextIterationTimeout = setTimeoutRecorder.calls.find(
              (call) => {
                return call.duration === blockTrackerOptions.pollingInterval;
              },
            );
            expect(nextIterationTimeout).not.toBeUndefined();
            expect(nextIterationTimeout?.timeout.hasRef()).toBe(false);
          },
        );
      });

      it('should set the current block number and then clear it some time afterward', async () => {
        const setTimeoutRecorder = recordCallsToSetTimeout();
        const blockTrackerOptions = {
          pollingInterval: 100,
          blockResetDuration: 200,
        };

        await withPollingBlockTracker(
          {
            provider: {
              stubs: [
                {
                  methodName: 'eth_blockNumber',
                  response: {
                    result: '0x0',
                  },
                },
              ],
            },
            blockTracker: blockTrackerOptions,
          },
          async ({ blockTracker }) => {
            await new Promise((resolve) => {
              blockTracker.once('latest', resolve);
            });
            expect(blockTracker.getCurrentBlock()).toStrictEqual('0x0');

            // When the block tracker stops, there may be two `setTimeout`s in
            // play: one to go to the next iteration of the block tracker
            // loop, another to expire the current block number cache. We don't
            // know which one has been added first, so we have to find it.
            await setTimeoutRecorder.nextMatchingDuration(
              blockTrackerOptions.blockResetDuration,
            );
            expect(blockTracker.getCurrentBlock()).toBeNull();
          },
        );
      });

      METHODS_TO_ADD_LISTENER.forEach((methodToAddListener) => {
        it(`should emit the "error" event (added via \`${methodToAddListener}\`) and should not throw if the request for the latest block number returns an error response`, async () => {
          recordCallsToSetTimeout({ numAutomaticCalls: 1 });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      error: 'boom',
                    },
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const promiseForCaughtError = new Promise<any>((resolve) => {
                blockTracker[methodToAddListener]('error', resolve);
              });

              const promiseForLatestBlock = new Promise((resolve) => {
                blockTracker.once('latest', resolve);
              });

              const caughtError = await promiseForCaughtError;
              expect(caughtError.message).toMatch(
                /^PollingBlockTracker - encountered an error while attempting to update latest block:\nError: PollingBlockTracker - encountered error fetching block:\nboom\n/u,
              );
              const latestBlock = await promiseForLatestBlock;
              expect(latestBlock).toStrictEqual('0x0');
            },
          );
        });

        it(`should emit the "error" event (added via \`${methodToAddListener}\`) and should not throw if, while making the request for the latest block number, the provider throws an error that is an Error`, async () => {
          recordCallsToSetTimeout({ numAutomaticCalls: 1 });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    implementation: () => {
                      throw new Error('boom');
                    },
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const promiseForCaughtError = new Promise<any>((resolve) => {
                blockTracker[methodToAddListener]('error', resolve);
              });

              const promiseForLatestBlock = new Promise((resolve) => {
                blockTracker.once('latest', resolve);
              });

              const caughtError = await promiseForCaughtError;
              expect(caughtError.message).toMatch(
                /^PollingBlockTracker - encountered an error while attempting to update latest block:\nError: boom\n/u,
              );
              const latestBlock = await promiseForLatestBlock;
              expect(latestBlock).toStrictEqual('0x0');
            },
          );
        });

        it(`should emit the "error" event (added via \`${methodToAddListener}\`) and should not throw if, while making the request for the latest block number, the provider throws an error that is a string`, async () => {
          recordCallsToSetTimeout({ numAutomaticCalls: 1 });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    implementation: () => {
                      throw 'boom';
                    },
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const promiseForCaughtError = new Promise<any>((resolve) => {
                blockTracker[methodToAddListener]('error', resolve);
              });

              const promiseForLatestBlock = new Promise((resolve) => {
                blockTracker.once('latest', resolve);
              });

              const caughtError = await promiseForCaughtError;
              expect(caughtError.message).toMatch(
                /^PollingBlockTracker - encountered an error while attempting to update latest block:\nboom/u,
              );
              const latestBlock = await promiseForLatestBlock;
              expect(latestBlock).toStrictEqual('0x0');
            },
          );
        });

        it(`should emit the "error" event (added via \`${methodToAddListener}\`) and should not throw if, while making the request for the latest block number, the provider rejects with an error`, async () => {
          recordCallsToSetTimeout({ numAutomaticCalls: 1 });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    error: 'boom',
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const promiseForCaughtError = new Promise<any>((resolve) => {
                blockTracker[methodToAddListener]('error', resolve);
              });

              const promiseForLatestBlock = new Promise((resolve) => {
                blockTracker.once('latest', resolve);
              });

              const caughtError = await promiseForCaughtError;
              expect(caughtError.message).toMatch(
                /^PollingBlockTracker - encountered an error while attempting to update latest block:\nError: boom/u,
              );
              const latestBlock = await promiseForLatestBlock;
              expect(latestBlock).toStrictEqual('0x0');
            },
          );
        });
      });
    });

    describe('"sync"', () => {
      it('should start and then stop the block tracker automatically', async () => {
        // We stub 2 calls because PollingBlockTracker#_synchronize will make a call
        // (to proceed to the next iteration) and BaseBlockTracker will make a call
        // (to reset the current block number when the tracker is not running)
        recordCallsToSetTimeout({ numAutomaticCalls: 2 });

        await withPollingBlockTracker(async ({ blockTracker }) => {
          await new Promise((resolve) => {
            blockTracker.on('_ended', resolve);
            blockTracker.once('sync', EMPTY_FUNCTION);
          });

          expect(blockTracker.isRunning()).toBe(false);
        });
      });

      it('should set the current block number and then clear it some time afterward', async () => {
        const setTimeoutRecorder = recordCallsToSetTimeout();
        const blockTrackerOptions = {
          pollingInterval: 100,
          blockResetDuration: 200,
        };

        await withPollingBlockTracker(
          {
            provider: {
              stubs: [
                {
                  methodName: 'eth_blockNumber',
                  response: {
                    result: '0x0',
                  },
                },
              ],
            },
            blockTracker: blockTrackerOptions,
          },
          async ({ blockTracker }) => {
            await new Promise((resolve) => {
              blockTracker.once('sync', resolve);
            });
            expect(blockTracker.getCurrentBlock()).toStrictEqual('0x0');

            // When the block tracker stops, there may be two `setTimeout`s in
            // play: one to go to the next iteration of the block tracker
            // loop, another to expire the current block number cache. We don't
            // know which one has been added first, so we have to find it.
            await setTimeoutRecorder.nextMatchingDuration(
              blockTrackerOptions.blockResetDuration,
            );
            expect(blockTracker.getCurrentBlock()).toBeNull();
          },
        );
      });

      METHODS_TO_ADD_LISTENER.forEach((methodToAddListener) => {
        it(`should emit the "error" event (added via \`${methodToAddListener}\`) and should not throw if the request for the latest block number returns an error response`, async () => {
          recordCallsToSetTimeout({ numAutomaticCalls: 1 });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      error: 'boom',
                    },
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const promiseForCaughtError = new Promise<any>((resolve) => {
                blockTracker[methodToAddListener]('error', resolve);
              });

              const promiseForSync = new Promise((resolve) => {
                blockTracker.once('sync', resolve);
              });

              const caughtError = await promiseForCaughtError;
              expect(caughtError.message).toMatch(
                /^PollingBlockTracker - encountered an error while attempting to update latest block:\nError: PollingBlockTracker - encountered error fetching block:\nboom\n/u,
              );
              const sync = await promiseForSync;
              expect(sync).toStrictEqual({ oldBlock: null, newBlock: '0x0' });
            },
          );
        });

        it(`should emit the "error" event (added via \`${methodToAddListener}\`) and should not throw if, while making the request for the latest block number, the provider throws an error that is an Error`, async () => {
          recordCallsToSetTimeout({ numAutomaticCalls: 1 });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    implementation: () => {
                      throw new Error('boom');
                    },
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const promiseForCaughtError = new Promise<any>((resolve) => {
                blockTracker[methodToAddListener]('error', resolve);
              });

              const promiseForSync = new Promise((resolve) => {
                blockTracker.once('sync', resolve);
              });

              const caughtError = await promiseForCaughtError;
              expect(caughtError.message).toMatch(
                /^PollingBlockTracker - encountered an error while attempting to update latest block:\nError: boom\n/u,
              );
              const sync = await promiseForSync;
              expect(sync).toStrictEqual({ oldBlock: null, newBlock: '0x0' });
            },
          );
        });

        it(`should emit the "error" event (added via \`${methodToAddListener}\`) and should not throw if, while making the request for the latest block number, the provider throws an error that is a string`, async () => {
          recordCallsToSetTimeout({ numAutomaticCalls: 1 });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    implementation: () => {
                      throw 'boom';
                    },
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const promiseForCaughtError = new Promise<any>((resolve) => {
                blockTracker[methodToAddListener]('error', resolve);
              });

              const promiseForSync = new Promise((resolve) => {
                blockTracker.once('sync', resolve);
              });

              const caughtError = await promiseForCaughtError;
              expect(caughtError.message).toMatch(
                /^PollingBlockTracker - encountered an error while attempting to update latest block:\nboom/u,
              );
              const sync = await promiseForSync;
              expect(sync).toStrictEqual({ oldBlock: null, newBlock: '0x0' });
            },
          );
        });

        it(`should emit the "error" event (added via \`${methodToAddListener}\`) and should not throw if, while making the request for the latest block number, the provider rejects with an error`, async () => {
          recordCallsToSetTimeout({ numAutomaticCalls: 1 });

          await withPollingBlockTracker(
            {
              provider: {
                stubs: [
                  {
                    methodName: 'eth_blockNumber',
                    error: 'boom',
                  },
                  {
                    methodName: 'eth_blockNumber',
                    response: {
                      result: '0x0',
                    },
                  },
                ],
              },
            },
            async ({ blockTracker }) => {
              const promiseForCaughtError = new Promise<any>((resolve) => {
                blockTracker[methodToAddListener]('error', resolve);
              });

              const promiseForSync = new Promise((resolve) => {
                blockTracker.once('sync', resolve);
              });

              const caughtError = await promiseForCaughtError;
              expect(caughtError.message).toMatch(
                /^PollingBlockTracker - encountered an error while attempting to update latest block:\nError: boom/u,
              );
              const sync = await promiseForSync;
              expect(sync).toStrictEqual({ oldBlock: null, newBlock: '0x0' });
            },
          );
        });
      });
    });

    describe('some other event', () => {
      it('should never start the block tracker', async () => {
        // We stub 2 calls because PollingBlockTracker#_synchronize will make a call
        // (to proceed to the next iteration) and BaseBlockTracker will make a call
        // (to reset the current block number when the tracker is not running)
        recordCallsToSetTimeout({ numAutomaticCalls: 2 });

        await withPollingBlockTracker(async ({ blockTracker }) => {
          const listener = jest.fn();
          blockTracker.on('_ended', listener);
          blockTracker.once('somethingElse', EMPTY_FUNCTION);

          expect(listener).not.toHaveBeenCalled();
        });
      });

      it('should never set the current block number', async () => {
        recordCallsToSetTimeout({ numAutomaticCalls: 1 });

        await withPollingBlockTracker(
          {
            provider: {
              stubs: [
                {
                  methodName: 'eth_blockNumber',
                  response: {
                    result: '0x0',
                  },
                },
              ],
            },
          },
          async ({ blockTracker }) => {
            blockTracker.once('somethingElse', EMPTY_FUNCTION);
            expect(blockTracker.getCurrentBlock()).toBeNull();
          },
        );
      });
    });
  });

  describe('removeAllListeners', () => {
    it('should stop the block tracker if any "latest" and "sync" events were added previously', async () => {
      recordCallsToSetTimeout();

      await withPollingBlockTracker(async ({ blockTracker }) => {
        blockTracker.on('latest', EMPTY_FUNCTION);
        await new Promise((resolve) => {
          blockTracker.on('sync', resolve);
        });
        expect(blockTracker.isRunning()).toBe(true);

        blockTracker.removeAllListeners();
        expect(blockTracker.isRunning()).toBe(false);
      });
    });

    it('should clear the current block number some time after all "latest" and "sync" events are removed', async () => {
      const setTimeoutRecorder = recordCallsToSetTimeout();
      const blockTrackerOptions = {
        pollingInterval: 100,
        blockResetDuration: 200,
      };

      await withPollingBlockTracker(
        {
          provider: {
            stubs: [
              {
                methodName: 'eth_blockNumber',
                response: {
                  result: '0x0',
                },
              },
            ],
          },
          blockTracker: blockTrackerOptions,
        },
        async ({ blockTracker }) => {
          blockTracker.on('latest', EMPTY_FUNCTION);
          await new Promise((resolve) => {
            blockTracker.on('sync', resolve);
          });
          expect(blockTracker.getCurrentBlock()).toStrictEqual('0x0');

          blockTracker.removeAllListeners();
          // When the block tracker stops, there may be two `setTimeout`s in
          // play: one to go to the next iteration of the block tracker
          // loop, another to expire the current block number cache. We don't
          // know which one has been added first, so we have to find it.
          await setTimeoutRecorder.nextMatchingDuration(
            blockTrackerOptions.blockResetDuration,
          );
          expect(blockTracker.getCurrentBlock()).toBeNull();
        },
      );
    });

    it('should stop the block tracker when all previously added "latest" and "sync" events are removed specifically', async () => {
      recordCallsToSetTimeout();

      await withPollingBlockTracker(async ({ blockTracker }) => {
        await new Promise<void>((resolve) => {
          blockTracker.on('latest', EMPTY_FUNCTION);
          blockTracker.on('sync', resolve);
        });
        expect(blockTracker.isRunning()).toBe(true);

        blockTracker.removeAllListeners('latest');
        expect(blockTracker.isRunning()).toBe(true);

        blockTracker.removeAllListeners('sync');
        expect(blockTracker.isRunning()).toBe(false);
      });
    });

    it('should clear the current block number some time after all "latest" and "sync" events are removed specifically', async () => {
      const setTimeoutRecorder = recordCallsToSetTimeout();
      const blockTrackerOptions = {
        pollingInterval: 100,
        blockResetDuration: 200,
      };

      await withPollingBlockTracker(
        {
          provider: {
            stubs: [
              {
                methodName: 'eth_blockNumber',
                response: {
                  result: '0x0',
                },
              },
            ],
          },
          blockTracker: blockTrackerOptions,
        },
        async ({ blockTracker }) => {
          blockTracker.on('latest', EMPTY_FUNCTION);
          await new Promise((resolve) => {
            blockTracker.on('sync', resolve);
          });
          expect(blockTracker.getCurrentBlock()).toStrictEqual('0x0');

          blockTracker.removeAllListeners('latest');
          blockTracker.removeAllListeners('sync');
          // When the block tracker stops, there may be two `setTimeout`s in
          // play: one to go to the next iteration of the block tracker
          // loop, another to expire the current block number cache. We don't
          // know which one has been added first, so we have to find it.
          await setTimeoutRecorder.nextMatchingDuration(
            blockTrackerOptions.blockResetDuration,
          );
          expect(blockTracker.getCurrentBlock()).toBeNull();
        },
      );
    });
  });
});