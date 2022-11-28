# next-routes-dir

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
