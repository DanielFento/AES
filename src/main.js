// src/main.js
// Minimal app shell: editor + output + problems panel.

(function(){
  "use strict";

  const el = (id) => document.getElementById(id);

  const statusLeft = el("statusLeft");
  const statusRight = el("statusRight");
  const exampleSelect = el("exampleSelect");
  const loadExampleBtn = el("loadExample");
  const formatBtn = el("formatBtn");
  const copyBtn = el("copyBtn");
  const downloadBtn = el("downloadBtn");
  const themeBtn = el("themeBtn");
  const problemsEl = el("problems");

  const EXAMPLES = window.AES_EXAMPLES || {};

  function setStatus(target, msg, kind){
    target.textContent = msg;
    target.style.color = kind === "error" ? "var(--bad)" :
                         kind === "warn" ? "var(--warn)" :
                         kind === "ok" ? "var(--good)" : "var(--muted)";
  }

  function downloadText(filename, text){
    const blob = new Blob([text], { type:"text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(a.href);
    a.remove();
  }

  function copyToClipboard(text){
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    return Promise.resolve();
  }

  // Fill example dropdown
  for (const name of Object.keys(EXAMPLES)){
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    exampleSelect.appendChild(opt);
  }

  // Monaco worker glue for CDN builds.
  // This avoids CORS issues by using a blob URL.
  window.MonacoEnvironment = {
    getWorkerUrl: function (moduleId, label) {
      const workerMain = "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs/base/worker/workerMain.min.js";
      const proxy = `
        self.MonacoEnvironment = { baseUrl: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/' };
        importScripts('${workerMain}');
      `;
      return URL.createObjectURL(new Blob([proxy], { type: "text/javascript" }));
    }
  };

  // Load Monaco
  require.config({
    paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs" }
  });

  let monacoAPI, editor, outEditor, model, theme = "vs-dark";

  require(["vs/editor/editor.main"], function(){
    monacoAPI = window.monaco;

    window.setupAesMonaco(monacoAPI);

    editor = monacoAPI.editor.create(el("editor"), {
      value: EXAMPLES[Object.keys(EXAMPLES)[0]] || "",
      language: "aes",
      theme,
      fontSize: 13,
      minimap: { enabled: false },
      automaticLayout: true,
      tabSize: 2,
      insertSpaces: true,
      scrollBeyondLastLine: false,

      // Make suggestions feel "language-first", not random words.
      suggest: { showWords: false, preview: true },
      quickSuggestions: { other: true, comments: false, strings: true },
      acceptSuggestionOnEnter: "on",
      tabCompletion: "on",
    });

    model = editor.getModel();

    outEditor = monacoAPI.editor.create(el("outEditor"), {
      value: "",
      language: "cpp",
      theme,
      fontSize: 13,
      minimap: { enabled: false },
      readOnly: true,
      automaticLayout: true,
      tabSize: 2,
      scrollBeyondLastLine: false,
    });

    function setMarkers(diagnostics){
      const markers = diagnostics.map(d => ({
        severity: d.severity === "warning"
          ? monacoAPI.MarkerSeverity.Warning
          : monacoAPI.MarkerSeverity.Error,
        message: d.message,
        startLineNumber: d.line,
        startColumn: d.col || 1,
        endLineNumber: d.line,
        endColumn: (d.col || 1) + 1
      }));
      monacoAPI.editor.setModelMarkers(model, "aes", markers);
    }

    function renderProblems(diagnostics){
      problemsEl.innerHTML = "";
      const list = diagnostics.slice().sort((a,b) => (a.line - b.line));
      if (!list.length){
        problemsEl.innerHTML = `<div class="problem"><div class="row"><div class="msg">No problems 🎉</div><div class="sev">OK</div></div></div>`;
        return;
      }

      for (const d of list){
        const div = document.createElement("div");
        div.className = "problem " + (d.severity === "warning" ? "warn" : "error");
        div.innerHTML = `
          <div class="row">
            <div class="msg">${escapeHtml(d.message)}</div>
            <div class="sev">${d.severity === "warning" ? "WARN" : "ERROR"}</div>
          </div>
          <div class="row" style="margin-top:6px;">
            <div class="loc">line ${d.line}</div>
            <div class="loc"></div>
          </div>
        `;
        div.addEventListener("click", () => {
          editor.revealLineInCenter(d.line);
          editor.setPosition({ lineNumber: d.line, column: 1 });
          editor.focus();
        });
        problemsEl.appendChild(div);
      }
    }

    function escapeHtml(s){
      return String(s)
        .replace(/&/g,"&amp;")
        .replace(/</g,"&lt;")
        .replace(/>/g,"&gt;")
        .replace(/"/g,"&quot;")
        .replace(/'/g,"&#039;");
    }

    function runTranspile(){
      const src = editor.getValue();
      const res = window.AES.transpile(src);

      outEditor.setValue(res.cpp);
      setMarkers(res.diagnostics);
      renderProblems(res.diagnostics);

      const errs = res.diagnostics.filter(d => d.severity !== "warning");
      const warns = res.diagnostics.filter(d => d.severity === "warning");

      if (errs.length){
        setStatus(statusLeft, `${errs.length} error(s)`, "error");
        setStatus(statusRight, `Fix errors to download`, "error");
      } else if (warns.length){
        setStatus(statusLeft, `${warns.length} warning(s)`, "warn");
        setStatus(statusRight, `OK (warnings)`, "warn");
      } else {
        setStatus(statusLeft, `OK`, "ok");
        setStatus(statusRight, `Ready`, "ok");
      }

      return res;
    }

    // Debounced compile on change
    let t = null;
    editor.onDidChangeModelContent(() => {
      clearTimeout(t);
      t = setTimeout(runTranspile, 160);
    });

    // UI
    loadExampleBtn.addEventListener("click", () => {
      const name = exampleSelect.value;
      editor.setValue(EXAMPLES[name] || "");
      setStatus(statusLeft, `Loaded: ${name}`, "info");
      runTranspile();
    });

    formatBtn.addEventListener("click", () => {
      editor.getAction("editor.action.formatDocument").run();
    });

    copyBtn.addEventListener("click", async () => {
      const res = runTranspile();
      const errs = res.diagnostics.filter(d => d.severity !== "warning");
      if (errs.length) {
        setStatus(statusRight, "Can't copy: fix errors first", "error");
        return;
      }
      await copyToClipboard(res.cpp);
      setStatus(statusRight, "Copied C++ to clipboard", "ok");
    });

    downloadBtn.addEventListener("click", () => {
      const res = runTranspile();
      const errs = res.diagnostics.filter(d => d.severity !== "warning");
      if (errs.length){
        setStatus(statusRight, "Fix errors before downloading", "error");
        return;
      }
      downloadText("sketch.ino", res.cpp);
      setStatus(statusRight, "Downloaded sketch.ino", "ok");
    });

    themeBtn.addEventListener("click", () => {
      theme = (theme === "vs-dark") ? "vs" : "vs-dark";
      monacoAPI.editor.setTheme(theme);
    });

    // Initial
    runTranspile();
    setStatus(statusLeft, "Ready.", "info");
  });
})();
