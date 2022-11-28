# next-routes-dir

> **Note:** This package uses CommonJS because it needs to be imported from `next.config.js`, which does not support ESM very well.

## Usage

Import and run `setupRoutesDirectoryWatcher` in your `next.config.js` file:

```ts
// next.config.js
const { setupRoutesDirectoryWatcher } = require('next-routes-dir')
const path = require('path')

setupRoutesDirectoryWatcher({
  routesDir: path.join(__dirname, 'routes')
})

module.exports = {
  // ...
}
```
