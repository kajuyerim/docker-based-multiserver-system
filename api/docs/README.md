Swagger UI assets are vendored from `swagger-ui-dist` version **5.34.1**
([upstream](https://github.com/swagger-api/swagger-ui)). The bundle and stylesheet
are unmodified; the upstream Apache 2.0 license and NOTICE are included.
`index.html` loads the local OpenAPI spec, with no external validator or CDN.

To update, download the pinned npm package tarball, verify its npm integrity
hash, and replace `swagger-ui-bundle.js`, `swagger-ui.css`, `swagger-ui-bundle.js.LICENSE.txt`, `LICENSE`, and `NOTICE`.
