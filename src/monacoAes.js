// src/monacoAes.js
// Monaco language wiring for Arduino EasyScript (AES).
//
// This file is intentionally "editor-only":
// - highlighting
// - auto-indent + auto-insert 'end'
// - completions
// - hover help
// - format document
// - symbols + go-to-definition
//
// The compiler/transpiler lives in src/aes/service.js (window.AES).

(function(){
  "use strict";

  function setupAesMonaco(monaco){
    // Register language
    monaco.languages.register({ id: "aes" });

    // -----------------------------------------------------------------------
    // Syntax highlighting
    // -----------------------------------------------------------------------
    monaco.languages.setMonarchTokensProvider("aes", {
      defaultToken: "",
      tokenizer: {
        root: [
          [/#.*$/, "comment"],
          [/\/\/.*$/, "comment"],
          [/".*?"/, "string"],
          [/\b(A[0-5])\b/i, "constant"],
          [/\b(setup|loop|function|end|if|otherwise|repeat|times|forever|while|every|after|do)\b/i, "keyword"],
          [/\b(pin|make|turn|toggle|read|analog|time|micros|seed|into|set|change|by|wait|start|serial|print|call|map|from|to|limit|pick|random|play|tone|stop|pwm)\b/i, "type"],
          [/\b(is|equals|not|greater|less|than|at|least|most|and|or)\b/i, "operator"],
          [/\b(true|false|HIGH|LOW|INPUT|OUTPUT|INPUT_PULLUP)\b/i, "constant"],
          [/-?\d+(\.\d+)?/, "number"],
        ]
      }
    });

    // -----------------------------------------------------------------------
    // Language configuration (comments, indentation, auto 'end')
    // -----------------------------------------------------------------------
    const IndentAction = monaco.languages.IndentAction;

    monaco.languages.setLanguageConfiguration("aes", {
      comments: {
        lineComment: "#",
      },
      autoClosingPairs: [
        { open: "\"", close: "\"", notIn: ["string", "comment"] },
      ],
      surroundingPairs: [
        { open: "\"", close: "\"" },
      ],
      indentationRules: {
        increaseIndentPattern: /^\s*(?:setup:|loop:|function\s+[A-Za-z_]\w*\s*:|if\s+.+\s+do:|repeat\s+\d+\s+times\s+do:|forever\s+do:|while\s+.+\s+do:|every\s+\d+\s+\w+\s+do:|after\s+\d+\s+\w+\s+do:)\s*$/i,
        decreaseIndentPattern: /^\s*(?:end|otherwise\s+do:|otherwise:)\s*$/i,
      },
      onEnterRules: [
        // setup:/loop:
        {
          beforeText: /^\s*(setup:|loop:)\s*$/i,
          action: { indentAction: IndentAction.IndentOutdent, appendText: "end" }
        },
        // function name:
        {
          beforeText: /^\s*function\s+[A-Za-z_]\w*\s*:\s*$/i,
          action: { indentAction: IndentAction.IndentOutdent, appendText: "end" }
        },
        // if ... do:
        {
          beforeText: /^\s*if\s+.+\s+do:\s*$/i,
          action: { indentAction: IndentAction.IndentOutdent, appendText: "end" }
        },
        // repeat
        {
          beforeText: /^\s*repeat\s+\d+\s+times\s+do:\s*$/i,
          action: { indentAction: IndentAction.IndentOutdent, appendText: "end" }
        },
        // forever
        {
          beforeText: /^\s*forever\s+do:\s*$/i,
          action: { indentAction: IndentAction.IndentOutdent, appendText: "end" }
        },
        // while
        {
          beforeText: /^\s*while\s+.+\s+do:\s*$/i,
          action: { indentAction: IndentAction.IndentOutdent, appendText: "end" }
        },
        // every/after timers
        {
          beforeText: /^\s*(every|after)\s+\d+\s*(ms|millisecond|milliseconds|second|seconds|s)\s+do:\s*$/i,
          action: { indentAction: IndentAction.IndentOutdent, appendText: "end" }
        },
        // otherwise do: (indent only)
        {
          beforeText: /^\s*(otherwise\s+do:|otherwise:)\s*$/i,
          action: { indentAction: IndentAction.Indent }
        },
      ],
      folding: {
        markers: {
          start: new RegExp("^\\s*(setup:|loop:|function\\s+[A-Za-z_]\\w*\\s*:|if\\s+.+\\s+do:|repeat\\s+\\d+\\s+times\\s+do:|forever\\s+do:|while\\s+.+\\s+do:|every\\s+\\d+\\s+\\w+\\s+do:|after\\s+\\d+\\s+\\w+\\s+do:)\\s*$", "i"),
          end: new RegExp("^\\s*end\\s*$", "i"),
        }
      }
    });

    // -----------------------------------------------------------------------
    // Completion provider (context-aware)
    // -----------------------------------------------------------------------
    const CompletionItemKind = monaco.languages.CompletionItemKind;
    const InsertAsSnippet = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

    const cache = new WeakMap(); // model -> { versionId, symbols }

    function getSymbolsCached(model){
      const v = model.getVersionId();
      const c = cache.get(model);
      if (c && c.versionId === v) return c.symbols;
      const analysis = window.AES.extractSymbols(model.getValue());
      const symbols = analysis.symbols;
      cache.set(model, { versionId: v, symbols });
      return symbols;
    }

    function tokenizeUpToCursor(model, position){
      const line = model.getLineContent(position.lineNumber);
      const before = line.slice(0, position.column - 1);
      const toks = (before.match(/"([^"\\]|\\.)*"|\S+/g) || []);
      const endsWithSpace = /\s$/.test(before);
      const currentPrefix = endsWithSpace ? "" : (toks[toks.length - 1] || "");
      return { toks, currentPrefix, before };
    }

    function makeRange(model, position){
      const word = model.getWordUntilPosition(position);
      return {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn
      };
    }

    function mk(label, insertText, kind, detail, range, sortText){
      return { label, insertText, kind, detail, range, sortText };
    }

    function snip(label, insertText, detail, range, sortText){
      return { label, insertText, kind: CompletionItemKind.Snippet, insertTextRules: InsertAsSnippet, detail, range, sortText };
    }

    function startsWith(prefix, s){
      if (!prefix) return true;
      return String(s).toLowerCase().startsWith(String(prefix).toLowerCase());
    }

    function pinCandidates(symbols){
      const pins = [];
      for (let i = 0; i <= 13; i++) pins.push(String(i));
      pins.push("A0","A1","A2","A3","A4","A5");
      for (const [name] of symbols.pins.entries()) pins.push(name);
      return pins;
    }

    function varCandidates(symbols){
      const vars = [];
      for (const [name] of symbols.vars.entries()) vars.push(name);
      return vars.sort();
    }

    function funcCandidates(symbols){
      const fns = [];
      for (const [name] of symbols.funcs.entries()) fns.push(name);
      return fns.sort();
    }

    monaco.languages.registerCompletionItemProvider("aes", {
      triggerCharacters: [" ", ":", '"'],
      provideCompletionItems: (model, position) => {
        const symbols = getSymbolsCached(model);
        const { toks, currentPrefix } = tokenizeUpToCursor(model, position);
        const range = makeRange(model, position);

        const out = [];

        const lower = toks.map(t => t.toLowerCase());
        const cmd = lower[0] || "";

        // At start-of-line / empty token: show block templates + top commands
        if (toks.length === 0 || (/^\s*$/.test(model.getLineContent(position.lineNumber).slice(0, position.column - 1)))) {
          out.push(
            snip("setup:", "setup:\n  $0\nend", "Runs once at start", range, "a0"),
            snip("loop:", "loop:\n  $0\nend", "Runs forever", range, "a1"),
            snip("function …:", "function ${1:name}:\n  $0\nend", "Define a function", range, "a2"),
            snip("if … do:", "if ${1:condition} do:\n  $0\nend", "If block", range, "a3"),
            snip("repeat … times do:", "repeat ${1:10} times do:\n  $0\nend", "Repeat loop", range, "a4"),
            snip("forever do:", "forever do:\n  $0\nend", "Infinite loop", range, "a5"),
            snip("while … do:", "while ${1:condition} do:\n  $0\nend", "While loop", range, "a6"),
            snip("every … ms do:", "every ${1:250} ms do:\n  $0\nend", "Non-blocking timer", range, "a7"),
            snip("after … ms do:", "after ${1:1000} ms do:\n  $0\nend", "Run once later", range, "a8"),
            snip("pin NAME is …", "pin ${1:name} is ${2:13}", "Name a pin", range, "b0"),
            mk("make", "make ", CompletionItemKind.Keyword, "Set pin mode", range, "b1"),
            mk("turn", "turn ", CompletionItemKind.Keyword, "Digital write", range, "b2"),
            mk("toggle", "toggle ", CompletionItemKind.Keyword, "Flip pin state", range, "b3"),
            mk("read", "read ", CompletionItemKind.Keyword, "Read pin", range, "b4"),
            mk("set", "set ", CompletionItemKind.Keyword, "Set variable", range, "b5"),
            mk("change", "change ", CompletionItemKind.Keyword, "Change variable", range, "b6"),
            mk("wait", "wait ", CompletionItemKind.Keyword, "Delay", range, "b7"),
            mk("print", "print ", CompletionItemKind.Keyword, "Serial print", range, "b8"),
            mk("call", "call ", CompletionItemKind.Keyword, "Call function", range, "b9"),
            mk("seed", "seed ", CompletionItemKind.Keyword, "Seed random()", range, "c0")
          );
          return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
        }

        // pin NAME is ...
        if (cmd === "pin") {
          if (toks.length === 1) {
            out.push(snip("pin led is 13", "pin ${1:led} is ${2:13}", "Define a named pin", range, "a0"));
            return { suggestions: out };
          }
          if (toks.length === 2 && !/\s$/.test(model.getLineContent(position.lineNumber).slice(0, position.column - 1))) {
            // user typing name
            return { suggestions: out };
          }
          if (toks.length >= 3 && lower[2] === "is") {
            for (const p of pinCandidates(symbols)) out.push(mk(p, p, CompletionItemKind.Constant, "Pin", range, "a" + p));
            return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
          }
        }

        // make <pin> <mode>
        if (cmd === "make") {
          if (toks.length === 1) {
            for (const p of pinCandidates(symbols)) out.push(mk(p, p + " ", CompletionItemKind.Constant, "Pin", range, "a" + p));
            out.unshift(mk("pin", "pin ", CompletionItemKind.Keyword, "Pin literal", range, "a0"));
            return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
          }

          // If current token is "pin", suggest pins
          if (lower[1] === "pin" && toks.length === 2) {
            for (const p of pinCandidates(symbols)) out.push(mk(p, p, CompletionItemKind.Constant, "Pin", range, "a" + p));
            return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
          }

          // After a pin, suggest modes
          const maybeModePos = toks.length >= 2;
          if (maybeModePos) {
            out.push(
              mk("output", "output", CompletionItemKind.Keyword, "pinMode OUTPUT", range, "a0"),
              mk("input", "input", CompletionItemKind.Keyword, "pinMode INPUT", range, "a1"),
              mk("input pullup", "input pullup", CompletionItemKind.Keyword, "pinMode INPUT_PULLUP", range, "a2"),
              mk("input_pullup", "input_pullup", CompletionItemKind.Keyword, "pinMode INPUT_PULLUP", range, "a3")
            );
            return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
          }
        }

        // turn <pin> on/off
        if (cmd === "turn") {
          if (toks.length === 1) {
            for (const p of pinCandidates(symbols)) out.push(mk(p, p + " ", CompletionItemKind.Constant, "Pin", range, "a" + p));
            out.unshift(mk("pin", "pin ", CompletionItemKind.Keyword, "Pin literal", range, "a0"));
            return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
          }
          // after pin: on/off
          out.push(
            mk("on", "on", CompletionItemKind.Keyword, "digitalWrite HIGH", range, "a0"),
            mk("off", "off", CompletionItemKind.Keyword, "digitalWrite LOW", range, "a1")
          );
          return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
        }

        // toggle <pin>
        if (cmd === "toggle") {
          if (toks.length === 1) {
            for (const p of pinCandidates(symbols)) out.push(mk(p, p, CompletionItemKind.Constant, "Pin", range, "a" + p));
            out.unshift(mk("pin", "pin ", CompletionItemKind.Keyword, "Pin literal", range, "a0"));
            return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
          }
        }

        // read ...
        if (cmd === "read") {
          if (toks.length === 1) {
            out.push(
              mk("analog", "analog ", CompletionItemKind.Keyword, "analogRead", range, "a0"),
              mk("time", "time into ", CompletionItemKind.Keyword, "millis()", range, "a1"),
              mk("micros", "micros into ", CompletionItemKind.Keyword, "micros()", range, "a2"),
              mk("pin", "pin ", CompletionItemKind.Keyword, "digitalRead", range, "a3")
            );
            for (const p of pinCandidates(symbols)) out.push(mk(p, p + " ", CompletionItemKind.Constant, "Pin", range, "b" + p));
            return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
          }

          // read analog <pin> into <var>
          if (lower[1] === "analog") {
            if (toks.length === 2) {
              for (const p of ["A0","A1","A2","A3","A4","A5", ...Array.from(symbols.pins.keys())]) out.push(mk(p, p + " ", CompletionItemKind.Constant, "Analog pin", range, "a" + p));
              return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
            }
            if (!lower.includes("into")) {
              out.push(mk("into", "into ", CompletionItemKind.Keyword, "Store result in a variable", range, "a0"));
              return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
            }
          }

          // read time into <var>
          if (lower[1] === "time") {
            for (const v of varCandidates(symbols)) out.push(mk(v, v, CompletionItemKind.Variable, "Variable", range, "a" + v));
            out.push(snip("new variable", "${1:now}", "Variable name", range, "b0"));
            return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
          }

          // read micros into <var>
          if (lower[1] === "micros") {
            for (const v of varCandidates(symbols)) out.push(mk(v, v, CompletionItemKind.Variable, "Variable", range, "a" + v));
            out.push(snip("new variable", "${1:now}", "Variable name", range, "b0"));
            return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
          }

          // digital read
          if (!lower.includes("into")) {
            out.push(mk("into", "into ", CompletionItemKind.Keyword, "Store result in a variable", range, "a0"));
            return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
          } else {
            for (const v of varCandidates(symbols)) out.push(mk(v, v, CompletionItemKind.Variable, "Variable", range, "a" + v));
            out.push(snip("new variable", "${1:value}", "Variable name", range, "b0"));
            return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
          }
        }

        // set ...
        if (cmd === "set") {
          if (toks.length === 1) {
            for (const v of varCandidates(symbols)) out.push(mk(v, v + " ", CompletionItemKind.Variable, "Variable", range, "a" + v));
            out.push(snip("new variable", "${1:x} to ${2:0}", "set x to 0", range, "b0"));
            out.push(snip("set pin PWM", "${1:led} to pwm ${2:128}", "analogWrite", range, "b1"));
            return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
          }
          // help with 'to'
          if (!lower.includes("to")) {
            out.push(mk("to", "to ", CompletionItemKind.Keyword, "Assign value", range, "a0"));
            return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
          }
          // suggest pwm after 'to'
          if (lower.includes("to") && !lower.includes("pwm")) {
            out.push(mk("pwm", "pwm ", CompletionItemKind.Keyword, "PWM write", range, "a0"));
          }
          return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
        }

        // change var by ...
        if (cmd === "change") {
          if (toks.length === 1) {
            for (const v of varCandidates(symbols)) out.push(mk(v, v + " ", CompletionItemKind.Variable, "Variable", range, "a" + v));
            return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
          }
          if (!lower.includes("by")) out.push(mk("by", "by ", CompletionItemKind.Keyword, "Delta", range, "a0"));
          return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
        }

        // call <function>
        if (cmd === "call") {
          for (const f of funcCandidates(symbols)) out.push(mk(f, f, CompletionItemKind.Function, "Function", range, "a" + f));
          out.push(snip("new call", "${1:name}", "Function name", range, "b0"));
          return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
        }

        // if ... do:
        if (cmd === "if") {
          for (const v of varCandidates(symbols)) out.push(snip(v + " is 0 do:", `${v} is 0 do:\n  $0\nend`, "If using variable", range, "a" + v));
          out.push(snip("if … do:", "if ${1:condition} do:\n  $0\nend", "If block", range, "b0"));
          return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
        }

        // otherwise
        if (cmd === "otherwise") {
          out.push(snip("otherwise do:", "otherwise do:\n  $0", "Else branch", range, "a0"));
          return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
        }

        // print
        if (cmd === "print") {
          out.push(
            snip('print "hello"', 'print "hello"', "Print text", range, "a0"),
            snip('print "x=" and x', 'print "x=" and ${1:x}', "Print label + value", range, "a1")
          );
          for (const v of varCandidates(symbols)) out.push(mk(v, v, CompletionItemKind.Variable, "Variable", range, "b" + v));
          return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
        }

                // seed random with ...
        if (cmd === "seed") {
          out.push(
            snip("seed random with 123", "seed random with ${1:123}", "randomSeed()", range, "a0"),
            snip("random seed 123", "random seed ${1:123}", "randomSeed()", range, "a1")
          );
          for (const v of varCandidates(symbols)) out.push(mk(v, v, CompletionItemKind.Variable, "Variable", range, "b" + v));
          return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
        }

// timers
        // timers
      if (cmd === "every" || cmd === "after") {
        out.push(
          // IMPORTANT: Monaco snippet placeholders like ${1:...} must NOT be treated as JS template interpolation.
          // So we avoid JS template literal interpolation for the snippet body.
          snip(
            `${cmd} 250 ms do:`,
            cmd + " ${1:250} ms do:\n  $0\nend",
            "Timer block",
            range,
            "a0"
          ),
          mk("ms", "ms ", CompletionItemKind.Keyword, "Milliseconds", range, "b0"),
          mk("seconds", "seconds ", CompletionItemKind.Keyword, "Seconds", range, "b1")
        );
        return { suggestions: out.filter(s => startsWith(currentPrefix, s.label)) };
      }

      // fallback: offer common keywords (but lower priority)
      const fallback = [
        mk("make", "make ", CompletionItemKind.Keyword, "Set pin mode", range, "z1"),
        mk("turn", "turn ", CompletionItemKind.Keyword, "Digital write", range, "z2"),
        mk("read", "read ", CompletionItemKind.Keyword, "Read pin", range, "z3"),
        mk("set", "set ", CompletionItemKind.Keyword, "Assign variable", range, "z4"),
        mk("wait", "wait ", CompletionItemKind.Keyword, "Delay", range, "z5"),
        mk("print", "print ", CompletionItemKind.Keyword, "Serial print", range, "z6"),
      ];
      return { suggestions: fallback.filter(s => startsWith(currentPrefix, s.label)) };

      }
    });

    // -----------------------------------------------------------------------
    // Hover provider (docs)
    // -----------------------------------------------------------------------
    monaco.languages.registerHoverProvider("aes", {
      provideHover: (model, position) => {
        const wordInfo = model.getWordAtPosition(position);
        if (!wordInfo) return null;

        const w = wordInfo.word;
        const docs = window.AES.docs || {};
        const key = (w.endsWith(":") ? w : w.toLowerCase());

        const entry =
          docs[w] ||
          docs[key] ||
          docs[key + ":"] ||
          docs[w.toLowerCase()] ||
          null;

        if (!entry) return null;

        const body = (entry.body || []).map(s => `- ${s}`).join("\n");
        const ex = entry.example ? `\n\nExample:\n\`\`\`aes\n${entry.example}\n\`\`\`` : "";

        return {
          range: new monaco.Range(position.lineNumber, wordInfo.startColumn, position.lineNumber, wordInfo.endColumn),
          contents: [
            { value: `**${entry.title || w}**\n\n${body}${ex}` }
          ]
        };
      }
    });

    // -----------------------------------------------------------------------
    // Format document (Shift+Alt+F)
    // -----------------------------------------------------------------------
    monaco.languages.registerDocumentFormattingEditProvider("aes", {
      provideDocumentFormattingEdits: (model) => {
        const formatted = window.AES.format(model.getValue());
        const fullRange = model.getFullModelRange();
        return [{ range: fullRange, text: formatted }];
      }
    });

    // -----------------------------------------------------------------------
    // Outline symbols (functions + pins + setup/loop)
    // -----------------------------------------------------------------------
    monaco.languages.registerDocumentSymbolProvider("aes", {
      provideDocumentSymbols: (model) => {
        const src = model.getValue().replace(/\r\n/g, "\n");
        const lines = src.split("\n");

        const syms = [];

        // setup + loop blocks
        for (let i = 0; i < lines.length; i++){
          const t = lines[i].trim();
          if (/^setup:\s*$/i.test(t)) {
            syms.push({
              name: "setup",
              detail: "block",
              kind: monaco.languages.SymbolKind.Method,
              range: new monaco.Range(i+1, 1, i+1, lines[i].length + 1),
              selectionRange: new monaco.Range(i+1, 1, i+1, 6)
            });
          }
          if (/^loop:\s*$/i.test(t)) {
            syms.push({
              name: "loop",
              detail: "block",
              kind: monaco.languages.SymbolKind.Method,
              range: new monaco.Range(i+1, 1, i+1, lines[i].length + 1),
              selectionRange: new monaco.Range(i+1, 1, i+1, 5)
            });
          }
        }

        const analysis = window.AES.extractSymbols(src);
        const symbols = analysis.symbols;

        for (const [name, info] of symbols.funcs.entries()){
          syms.push({
            name,
            detail: "function",
            kind: monaco.languages.SymbolKind.Function,
            range: new monaco.Range(info.line, 1, info.line, model.getLineLength(info.line) + 1),
            selectionRange: new monaco.Range(info.line, 1, info.line, model.getLineLength(info.line) + 1)
          });
        }
        for (const [name, info] of symbols.pins.entries()){
          syms.push({
            name,
            detail: `pin = ${info.cpp}`,
            kind: monaco.languages.SymbolKind.Constant,
            range: new monaco.Range(info.line, 1, info.line, model.getLineLength(info.line) + 1),
            selectionRange: new monaco.Range(info.line, 1, info.line, model.getLineLength(info.line) + 1)
          });
        }

        return syms;
      }
    });

    // -----------------------------------------------------------------------
    // Go to definition (functions + pins)
    // -----------------------------------------------------------------------
    monaco.languages.registerDefinitionProvider("aes", {
      provideDefinition: (model, position) => {
        const w = model.getWordAtPosition(position);
        if (!w) return null;

        const name = w.word;
        const analysis = window.AES.extractSymbols(model.getValue());
        const symbols = analysis.symbols;

        if (symbols.funcs.has(name)) {
          const info = symbols.funcs.get(name);
          return [{
            uri: model.uri,
            range: new monaco.Range(info.line, 1, info.line, model.getLineLength(info.line) + 1)
          }];
        }

        if (symbols.pins.has(name)) {
          const info = symbols.pins.get(name);
          return [{
            uri: model.uri,
            range: new monaco.Range(info.line, 1, info.line, model.getLineLength(info.line) + 1)
          }];
        }

        return null;
      }
    });
  }

  window.setupAesMonaco = setupAesMonaco;
})();
