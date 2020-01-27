import * as $$ from "rxjs";
import * as $ from "rxjs/operators";
import * as G from "graphql";
import * as E from "fp-ts/lib/Either";
import { pipe } from "fp-ts/lib/pipeable";
import { identity } from "fp-ts/lib/function";
import { PartialObserver, Unsubscribable } from "rxjs";
import * as Ix from 'ix';

export interface ObserverLike<T> {
  next: (value: T) => void;
  error: (err: any) => void;
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
  payload: {
    query: string;
    variables?: unknown;
    operationName?: string;
  };
}

interface OperationStop {
  type: OperationType.Stop;
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
  payload: {
    data: never;
    errors?: Array<{
      message: string;
    }>;
  };
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

function create(
  connection$: ObservableLike<
    [ObservableLike<Operation>, (out$: ObservableLike<Response>) => void]
  >,
  opts: {
    schema: G.GraphQLSchema;
    rootValue: unknown;
    execute: typeof G.execute;
    subscribe: typeof G.subscribe;
    onConnect: (connectionParams: unknown) => Promise<Record<string, unknown>>;
  }
): ObservableLike<Response> {
  return pipe(
    connection$,
    fromObservableLike,
    $.mergeMap(([operation$, notifyOut]) => {
      const out$ = pipe(
        operation$,
        fromObservableLike,
        $.mergeMap(operation => {
          switch (operation.type) {
            case OperationType.ConnectionInit:
              return pipe(
                $$.from(opts.onConnect(operation.payload)),
                $.mapTo({ type: ResponseType.ConnectionAck }),
                $.catchError((err: unknown) =>
                  $$.of<Response>({
                    type: ResponseType.ConnectionError,
                    payload: {
                      message:
                        err instanceof Error ? err.message : "Unknown error."
                    }
                  })
                )
              );
            case OperationType.Start: {
              const parseResult = E.tryCatch(
                () => G.parse(operation.payload.query),
                (err: unknown) =>
                  err instanceof G.GraphQLError
                    ? [err.message]
                    : ["Could not parse the query. Unknown error."]
              );
              const x = pipe(
                parseResult,
                E.chain(document => {
                  const errors = G.validate(
                    opts.schema,
                    document,
                    G.specifiedRules
                  );
                  return errors.length === 0
                    ? E.right(document)
                    : E.left(errors.map(e => e.message));
                }),
                E.map(document =>
                  G.getOperationAST(document, operation.payload.operationName)
                    ?.operation === "subscription"
                    ? opts.subscribe(opts.schema, document, opts.rootValue)
                    : opts.execute(opts.schema, document, opts.rootValue)
                ),
                E.map(executionResult => {
                  // if (Symbol.asyncIterator in executionResult && typeof executionResult[Symbol.asyncIterator] === 'function') {
                  G.isAsync
                    Ix.AsyncIterable.from(executionResult)
                  // }
                  return null;
                })

                // $$.from(G.validate(schema,))
                // $$.of({}),
              );
              return null as any;
            }
            default:
              return $$.of({});
          }
        })
      );
      notifyOut(toObservableLike(out$));
      return out$;
    }),
    toObservableLike
  );
}

function fromObservableLike<T>(o$: ObservableLike<T>): $$.Observable<T> {
  return new $$.Observable(observer => {
    o$.subscribe({
      next(v) {
        observer.next(v);
      },
      error(err) {
        observer.error(err);
      },
      complete() {
        observer.complete();
      }
    });
  });
}

function toObservableLike<T>(o$: $$.Observable<T>): ObservableLike<T> {
  return {
    subscribe(observer): { unsubscribe: () => void } {
      return o$.subscribe({
        next(v) {
          observer.next(v);
        },
        error(err) {
          observer.error(err);
        },
        complete() {
          observer.complete();
        }
      });
    }
  };
}

function fromAsyncIterable<T>(i: AsyncIterableIterator<T>): $$.Observable<T> {
  return new $$.Observable(observer => {
    i.next;
  });
}
