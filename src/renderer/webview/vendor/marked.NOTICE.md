Marked 18.0.13, vendored without changes from its official npm distribution.

- Source: https://registry.npmjs.org/marked/-/marked-18.0.13.tgz
- Upstream: https://github.com/markedjs/marked
- License: `marked.LICENSE` (MIT)
- Archive integrity, verified before extraction:
  `sha512-xTxVzZsBFwunP6HDmtBkabUQEYArnP7/rMDGmPj9SlrKlQ4i8MdYVow+nJL0eOqwpUqhzBoTBRADGN6uYwPyOw==`

The IDE loads this local browser build before `message-markdown.js`. Marked output
passes through the component's DOM allowlist before it enters the document.
