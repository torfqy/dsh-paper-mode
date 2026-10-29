# Headless mount test for the browser half

Renders the real `client.js` inside jsdom with a mocked Host API and asserts the
interactions a user performs — the auto-open + build flow, the manual compile
button (which used to do nothing when the document had not changed), typing and
autosave, the pane toggles, and the compile-settings panel.

```bash
cd paper-mode/test
npm install          # react, react-dom, jsdom — declared in this folder only
node mount.test.mjs
```

Dependencies live in this folder's own `package.json` so nothing is added to the
plugin package: the Harness serves the plugin as plain JavaScript and it must
stay dependency-free.
