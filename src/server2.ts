import * as G from "graphql";
import { withLatestFrom } from "rxjs/operators";

export interface ObserverLike<T> {
  next: (value: T) => void;
  error: (err: unknown) => void;
  complete: () => void;
}

export interface ObservableLike<T> {
  subscribe(
    observer: ObserverLike<T>
  ): {
    unsubscribe: () => void;
  };
}

type ConnectionParams = unknown;

interface OperationInit {
  type: OperationType.ConnectionInit;
  payload: unknown;
}

interface OperationStart {
  type: OperationType.Start;
  id: string;
  payload: {
    query: string;
    variables?: unknown;
    operationName?: string;
  };
}

interface OperationStop {
  type: OperationType.Stop;
  id: string;
}

interface OperationTerminate {
  type: OperationType.ConnectionTerminate;
}

enum OperationType {
  ConnectionInit = "GQL_CONNECTION_INIT",
  Start = "GQL_START",
  Stop = "GQL_STOP",
  ConnectionTerminate = "GQL_CONNECTION_TERMINATE"
}

enum ResponseType {
  ConnectionError = "GQL_CONNECTION_ERROR",
  ConnectionAck = "GQL_CONNECTION_ACK",
  Data = "GQL_DATA",
  Error = "GQL_ERROR",
  Complete = "GQL_COMPLETE"
}

export interface OperationMessagePayload {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export type Operation =
  | OperationInit
  | OperationStart
  | OperationStop
  | OperationTerminate;

export interface ResponseConnectionError {
  type: ResponseType.ConnectionError;
  payload: { message: string };
}

export interface ResponseConnectionAck {
  type: ResponseType.ConnectionAck;
}

export interface ResponseData {
  type: ResponseType.Data;
  id: string;
  payload: G.ExecutionResult<Record<string, unknown>>;
}

export interface ResponseError {
  type: ResponseType.Error;
  id: string;
  payload: {
    message: string;
  };
}

export interface ResponseComplete {
  type: ResponseType.Complete;
  id: string;
}

export type Response =
  | ResponseConnectionError
  | ResponseConnectionAck
  | ResponseData
  | ResponseError
  | ResponseComplete;

interface ConnectionIterable {
  [Symbol.asyncIterator](): AsyncIterator<
    OperationIterable,
    false,
    ResponseIterable
  >;
}
interface OperationIterable {
  [Symbol.asyncIterator](): AsyncIterator<Operation, undefined, undefined>;
}
interface ResponseIterable {
  [Symbol.asyncIterator](): AsyncIterator<Response, undefined, undefined>;
}

interface Options {
  schema: G.GraphQLSchema;
  rootValue: unknown;
  execute: typeof G.execute;
  subscribe: typeof G.subscribe;
  onConnect: (connectionParams: unknown) => Promise<Record<string, unknown>>;
}

async function* handleConnectionInit(
  it: OperationIterable,
  opts: Options
): AsyncGenerator<Response, void, undefined> {
  async function* getInit(): AsyncGenerator<Response, void, undefined> {
    for await (const op of it) {
      if (op.type !== OperationType.ConnectionInit) {
        continue;
      }
      try {
        const context = await opts.onConnect(op.payload);
        yield { type: ResponseType.ConnectionAck };
        yield* handleStart(it, context, opts);
      } catch (err) {
        yield {
          type: ResponseType.ConnectionError,
          payload: {
            message:
              err instanceof Error ? err.message : "Unknown connection error."
          }
        };
      }
    }
  }
  const terminateIter = it[Symbol.asyncIterator]();
  try {
    const init$ = getInit();
    (async function(): Promise<void> {
      const terminate = await find(
        terminateIter,
        (op): op is OperationTerminate =>
          op.type === OperationType.ConnectionTerminate
      );
      if (terminate) {
        init$.return?.();
      }
    })();
    yield* init$;
  } finally {
    terminateIter.return?.();
  }
}

async function* handleStart(
  it: OperationIterable,
  context: Record<string, unknown>,
  opts: Options
): AsyncGenerator<Response, void, undefined> {
  for await (const operation of it) {
    if (operation.type !== OperationType.Start) continue;

    let document: G.DocumentNode;
    try {
      document = G.parse(operation.payload.query);
    } catch (err) {
      if (err instanceof G.GraphQLError) {
        yield {
          type: ResponseType.Error,
          id: operation.id,
          payload: { message: err.message }
        };
      } else {
        yield {
          type: ResponseType.Error,
          id: operation.id,
          payload: { message: "Could not parse the query. Unknown error." }
        };
      }
      break;
    }
    const validationErrors = G.validate(
      opts.schema,
      document,
      G.specifiedRules
    );
    if (validationErrors.length > 0) {
      yield {
        type: ResponseType.Data,
        id: operation.id,
        payload: {
          errors: validationErrors
        }
      };
      break;
    }
    const operationType = G.getOperationAST(
      document,
      operation.payload.operationName
    )?.operation;

    if (operationType === "subscription") {
      yield* handleSubscription(operation.id, it, document, opts);
    } else {
      const result = await opts.execute(opts.schema, document, opts.rootValue);
      yield {
        type: ResponseType.Data,
        id: operation.id,
        payload: result
      };
    }
    yield {
      type: ResponseType.Complete,
      id: operation.id
    };
    break;
  }
}

export function create(connection$: ConnectionIterable, opts: Options): void {
  async function* start(): AsyncGenerator<Response, undefined, undefined> {
    const connIter = connection$[Symbol.asyncIterator]();
    const x = await connIter.next();
    if (x.done) {
      return;
    }

    if (!x.value) {
      return;
    }

    const getResponseIter = x.value[Symbol.asyncIterator];
    const responseIter = getResponseIter();
    const y = await responseIter.next();
    if (y.done) {
      return;
    }

    const operation = y.value;

    let context: Record<string, unknown> | undefined;
    type SubscriptionDataIter = AsyncIterableIterator<G.ExecutionResult>;
    const map = new Map<string, SubscriptionDataIter>();

    switch (operation.type) {
      case OperationType.ConnectionInit: {
        try {
          context = await opts.onConnect(operation.payload);
          yield { type: ResponseType.ConnectionAck };
        } catch (err) {
          yield {
            type: ResponseType.ConnectionError,
            payload: {
              message:
                err instanceof Error ? err.message : "Unknown connection error."
            }
          };
        }
        break;
      }
      case OperationType.Start: {
        let document: G.DocumentNode;
        try {
          document = G.parse(operation.payload.query);
        } catch (err) {
          if (err instanceof G.GraphQLError) {
            yield {
              type: ResponseType.Error,
              id: operation.id,
              payload: { message: err.message }
            };
          } else {
            yield {
              type: ResponseType.Error,
              id: operation.id,
              payload: { message: "Could not parse the query. Unknown error." }
            };
          }
          break;
        }
        const validationErrors = G.validate(
          opts.schema,
          document,
          G.specifiedRules
        );
        if (validationErrors.length > 0) {
          yield {
            type: ResponseType.Data,
            id: operation.id,
            payload: {
              errors: validationErrors
            }
          };
          break;
        }
        const operationType = G.getOperationAST(
          document,
          operation.payload.operationName
        )?.operation;

        if (operationType === "subscription") {
          yield* handleSubscription(operation.id, x.value, document, opts);
        } else {
          const result = await opts.execute(
            opts.schema,
            document,
            opts.rootValue
          );
          yield {
            type: ResponseType.Data,
            id: operation.id,
            payload: result
          };
        }
        yield {
          type: ResponseType.Complete,
          id: operation.id
        };
        break;
      }
      case OperationType.Stop: {
        const dataIter = map.get(operation.id);
        dataIter?.return?.();
        // close dataIter
        break;
      }
      case OperationType.ConnectionTerminate:
        // close response
        // close dataIter
        await responseIter.return?.();
        break;
    }
  }
}

interface SubscriptionIterable {
  [Symbol.asyncIterator](): AsyncIterator<Response, undefined, undefined>;
}

async function* handleSubscription(
  operationId: string,
  operation$: OperationIterable,
  document: G.DocumentNode,
  opts: Options
): AsyncGenerator<Response, void, undefined> {
  const operationIter = operation$[Symbol.asyncIterator]();

  async function* subscribe(): AsyncGenerator<Response, void, undefined> {
    const resultOrIter = await opts.subscribe(
      opts.schema,
      document,
      opts.rootValue
    );
    if ("next" in resultOrIter) {
      const iter = resultOrIter;
      for await (const result of iter) {
        yield {
          type: ResponseType.Data,
          payload: result,
          id: operationId
        };
      }
    } else {
      const result = resultOrIter;
      yield {
        type: ResponseType.Data,
        payload: result,
        id: operationId
      };
    }
  }

  try {
    const msg$ = subscribe();
    (async function(): Promise<void> {
      const stop = await find(
        operationIter,
        (op): op is OperationStop =>
          op.type === OperationType.Stop && op.id === operationId
      );
      if (stop) {
        msg$.return();
      }
    })();
    yield* msg$;
  } finally {
    operationIter.return?.();
  }
}

async function find<T>(it: AsyncIterator<T>, predicate: (t: T) => boolean) {
  for await (const op of {
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    [Symbol.asyncIterator]: () => it
  }) {
    if (predicate(op)) {
      return op;
    }
  }
}

//   return {
//     [Symbol.asyncIterator](): AsyncIterator<Response, undefined, undefined> {
//       let done = false;
//       const msg$ = subscribe();
//       const op$ = operation$[Symbol.asyncIterator]();
//       const stop = (async function(): Promise<void> {
//         for (;;) {
//           const result = await op$.next();
//           if (result.done) break;
//           if (
//             result.value.type === OperationType.Stop &&
//             result.value.id === operationId
//           ) {
//             break;
//           }
//         }
//       })();

//       async function next(): Promise<IteratorResult<ResponseData, undefined>> {
//         if (done) {
//           return { value: undefined, done: true };
//         }
//         if ("next" in msg$) {
//           const result = await Promise.race([msg$.next(), stop]);
//           // stop triggered.
//           if (!result) {
//             return return_();
//           }
//           // data source is done
//           else if (result.done) {
//             return return_();
//           }
//           // we have a value to return
//           else {
//             return {
//               value: {
//                 type: ResponseType.Data,
//                 payload: result.value,
//                 id: operationId
//               },
//               done: false
//             };
//           }
//         } else {
//           await return_();
//           return {
//             value: {
//               type: ResponseType.Data as const,
//               payload: msg$,
//               id: operationId
//             },
//             done: false
//           };
//         }
//       }

//       async function return_(): Promise<
//         IteratorResult<ResponseData, undefined>
//       > {
//         if (!done) {
//           op$.return?.();
//           if ("return" in msg$) {
//             msg$.return?.();
//           }
//         }
//         done = true;
//         return { done: true, value: undefined };
//       }

//       async function throw_(
//         err: unknown
//       ): Promise<IteratorResult<ResponseData, undefined>> {
//         await return_();
//         throw err;
//       }

//       return {
//         next,
//         return: return_,
//         throw: throw_
//       };
//     }
//   };
// }
