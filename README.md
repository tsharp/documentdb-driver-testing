# documentdb-driver-testing
Driver Validation for DocumentDb and Mongo Wire Compatible Systems

## Mongoose adapters

The versioned adapters `mongoose-5.x` through `mongoose-9.x` pin the latest
validated release for their respective major version. Build their dependencies
using the configured npm registry, then select any combination in the harness:

```powershell
.\run.ps1 build
.\run.ps1 test mongodb -Adapters mongoose-5.x,mongoose-6.x,mongoose-7.x,mongoose-8.x,mongoose-9.x
```

CRUD operations run through Mongoose models. Inserts and replacements perform
document validation, updates use `runValidators: true`, and bulk inserts and
replacements are validated before execution. Because harness scenarios do not
define application schemas, these adapters use `strict: false` so compatibility
tests can exercise arbitrary document shapes.
