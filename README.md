# neptune-lambda-client

## Overview
A very simple Gremlin client to robustly query AWS Neptune from AWS Lambda. The client will automatically
reestablish a connection to the database if the web socket connection closes and will also automatically 
retry (5 times) when it encounters `ConcurrentModificationException` and `ReadOnlyViolationException` errors.

## Usage

This client is instantiated with a factory function and exposes a single function called `query`. `query` accepts 
a single argument, which is a function that use the Gremlin `g` object.

```js
const gremlinClient = require('neptune-lambda-client');

const {query} = gremlinClient.create({
    host: 'neptune-db-url',
    port: '8182',
    useIam: true
});

async function getNode(id) {
    return query(async g => g.V(id).next().then(x => x.value));
}
```
