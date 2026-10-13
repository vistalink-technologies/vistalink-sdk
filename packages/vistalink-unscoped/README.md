# vistalink (npm)

> 0.0.x reserves the name; the first working release is 2.0.0, tracking API v2.

This package points at the VistaLink command line, which lives at
[`@vistalink/cli`](https://www.npmjs.com/package/@vistalink/cli). Install that
directly:

```bash
npm install -g @vistalink/cli
vistalink --help
```

`npm install -g vistalink` also works: it installs `@vistalink/cli` as a
dependency and its `vistalink` command runs the same binary. Do not install both
globally, since each one provides a `vistalink` command.

For the TypeScript SDK see [`@vistalink/api`](https://www.npmjs.com/package/@vistalink/api).
For the Python SDK, `pip install vistalink`. Docs: https://vistalink.com/developers
