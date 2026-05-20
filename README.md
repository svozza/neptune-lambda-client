# neptune-lambda-client

## Overview
A very simple Gremlin client to robustly query AWS Neptune from AWS Lambda. The client will automatically
reestablish a connection to the database if the web socket connection closes and will also automatically
retry (up to 5 times, with exponential backoff and jitter) when it encounters `ConcurrentModificationException`
and `ReadOnlyViolationException` errors.

## Usage

This client is instantiated with a factory function and exposes a `query` function that accepts a single
argument: a function that uses the Gremlin `g` object. It also exposes a `close` function for graceful shutdown.

```js
import { create } from 'neptune-lambda-client';

const { query } = create('neptune-db-url', '8182', { useIam: true });

async function getNode(id) {
    return query(async g => g.V(id).next().then(x => x.value));
}
```

## Known limitations

Per the [AWS Neptune Lambda guidance](https://docs.aws.amazon.com/neptune/latest/userguide/lambda-functions-examples.html#lambda-functions-examples-javascript),
if the underlying WebSocket is closed after the driver sends a request but before the response arrives,
the query resolves with `undefined` rather than throwing. Because this state cannot be turned into an
exception on the request/response path, we instead throw from the socket's `close` handler when the close
code is `1006` (abnormal closure) — this surfaces as an unhandled exception that fails the Lambda
invocation, so the client invoking the Lambda can retry. We recommend implementing retry logic on the
caller side as well as using the built-in retry in this library.
