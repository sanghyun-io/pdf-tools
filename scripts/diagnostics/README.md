# Historical diagnostics

These scripts and logs document exploratory checks from October 2026. They are not maintained tests, and the saved logs do not establish that the black-page issue is fixed or currently reproducible. Run from the repository root only after reviewing each script.

The scripts require a separately installed `playwright-core`, compatible Chrome or Edge, the application dependencies and an appropriate build or local preview server. The redaction repros require a user-supplied PDF and write into `tmp-debug/`; create that directory first. `repro-allpages.mjs` also expects `tmp-debug/dark.png`. The OCR check additionally needs its historical `tmp-debug/ocr/pages/` images and `truth.json`, which are not included. Some scripts depend on historical DOM and build paths and may need adaptation. Never use sensitive PDFs in an environment you do not trust.

`check-sw-update.mjs` modifies `dist/sw.js` and browser service-worker caches; use a disposable build and browser profile. The offline check disables networking in its browser context. No browser checks were rerun when these artifacts were archived.

The OCR research notes describe Tesseract 5.5.3 and refer to historical temporary source trees, models, and analysis scripts that are not included here. They are research notes, not bundled dependencies or reproducible instructions.
