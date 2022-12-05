# next-routes-dir

> **Note:** `next-routes-dir` is currently hardcoded to support its use-case in the [Dialect](https://github.com/Dialect-Inc) codebase, so it likely won't work as-is with your project. Before the code is rewritten to generalize to all Next.js projects, you're free to fork the project and tweak it to support your own use case!

`next-routes-dir` provides a way to use Next.js 13's `app/` directory colocation features while still using the feature-set of the old `pages/` directory. With `next-routes-dir`, you can create a `routes/` folder in your Next.js app that mirrors the folder structure of Next.js 13's `app/` directory, and it will automatically generate a valid `pages/` directory based on the structure of the `routes/` directory.

> You might be wondering, why don't we use Next.js 13's `app/` directory directly? In addition to the `app/` directory still being in beta, there are many incompatibilities and breaking changes from the `pages/` directory that require a substantial amount of work to migrate. However, the co-location features of the `app/` directory is very useful, so `next-routes-dir` provides a way to leverage the co-located structure of files inside the `app/` directory while still maintaining the same feature set provided by the `pages/` directory.

## Usage

Install `next-routes-dir` from npm:

```
npm install next-routes-dir
```

Then, refactor your existing `pages/` folder to the `app/` directory structure inside a `routes/` folder.

For example, the following `pages/` directory:

```
pages/
  - index.tsx
  - login.tsx
  - app
    - index.tsx
  - profile
    - [id].tsx
```

could be converted into the following `routes/` directory:  

```
routes/
  - login/
    - page.tsx
  // specify different layouts for marketing pages and app pages without affecting the URL
  - (marketing)/
    - page.tsx
  - (app)/
    - app/
      - page.tsx
    - profile/
      - [id]/
        page.tsx
```
    
Then, import and run `setupRoutesDirectoryWatcher` in your `next.config.js` file:

```ts
// next.config.js
const { setupRoutesDirectoryWatcher } = require('next-routes-dir')
const path = require('path')

setupRoutesDirectoryWatcher({
  routesDir: path.join(__dirname, 'routes'),
  pagesDir: path.join(__dirname, 'src/pages')
})

module.exports = {
  // ...
}
```
