// src/aes/service.js
// Arduino EasyScript (AES) language service + compiler.
//
// Design goals:
// - Beginner-friendly syntax (English-ish)
// - Zero external Arduino libraries (only Arduino core API)
// - Helpful diagnostics (errors + warnings), not cryptic parser failures
// - One place to add new commands (see COMMANDS table below)
//
// Public API (window.AES):
//   AES.transpile(source) -> { cpp, diagnostics, symbols }
//   AES.format(source)    -> formatted string
//   AES.extractSymbols(source) -> { pins, vars, funcs } with line numbers
//   AES.docs              -> keyword hover docs

(function(){
  "use strict";

  const AES = {};
  AES.version = "2.0.0";

  // ---------------------------------------------------------------------------
  // Reserved words (identifiers we don't let users declare)
  // ---------------------------------------------------------------------------
  const RESERVED = new Set([
    // Arduino core + common C/C++
    "setup","loop","Serial","delay","delayMicroseconds","millis","micros","pinMode",
    "digitalWrite","digitalRead","analogRead","analogWrite",
    "tone","noTone","map","random","randomSeed","HIGH","LOW","INPUT","OUTPUT","INPUT_PULLUP",
    "true","false","int","long","float","double","char","bool","void","String",
    // Language keywords
    "pin","make","turn","toggle","read","analog","into","set","change","by","to",
    "wait","ms","second","seconds",
    "start","serial","print","call","seed",
    "if","otherwise","do","end","repeat","times","forever","while","every","after","is"
  ]);

  // A simple board preset. You can extend this later (nano, mega, esp32...).
  const BOARD = {
    name: "uno",
    digitalPins: { min: 0, max: 13 },
    analogPins: ["A0","A1","A2","A3","A4","A5"],
    pwmPins: new Set([3,5,6,9,10,11])
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function normalizeNewlines(src){ return String(src || "").replace(/\r\n/g, "\n"); }
  function isIdentifier(s){ return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(s || "")); }
  function isIntLiteral(s){ return /^-?\d+$/.test(String(s || "").trim()); }
  function isAnalogLiteral(s){ return /^A[0-5]$/i.test(String(s || "").trim()); }
  function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

  function splitLineComment(line){
    // Find # or // not inside a double-quoted string.
    const s = String(line || "");
    let inStr = false;
    for (let i = 0; i < s.length; i++){
      const ch = s[i];
      if (ch === '"' && s[i-1] !== "\\") inStr = !inStr;
      if (!inStr){
        if (ch === "#") return { code: s.slice(0,i), comment: s.slice(i) };
        if (ch === "/" && s[i+1] === "/") return { code: s.slice(0,i), comment: s.slice(i) };
      }
    }
    return { code: s, comment: "" };
  }

  function stripComments(line){
    return splitLineComment(line).code;
  }

  function tokenize(s){
    // Splits by whitespace, but keeps "quoted strings" as a single token.
    return (String(s || "").match(/"([^"\\]|\\.)*"|\S+/g) || []);
  }

  function escapeCppString(s){
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function parseRange(rangeStr){
    const m = String(rangeStr).trim().match(/^(-?\d+)\.\.(-?\d+)$/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2])];
  }

  // ---------------------------------------------------------------------------
  // Symbols (pins, variables, functions)
  // ---------------------------------------------------------------------------
  function makeSymbols(){
    return {
      pins: new Map(), // name -> { cpp, raw, line }
      vars: new Map(), // name -> { type, line }
      funcs: new Map(), // name -> { line }
    };
  }

  function inferTypeFromExpr(expr){
    const t = String(expr || "").trim();
    if (/^"([^"\\]|\\.)*"$/.test(t)) return "String";
    if (/^(true|false)$/i.test(t)) return "bool";
    if (/^-?\d+\.\d+$/.test(t)) return "float";
    if (isIntLiteral(t)) return "long";
    return "long";
  }

  function ensureVar(symbols, name, typeHint, lineNo, diag){
    if (!isIdentifier(name)) return;
    if (RESERVED.has(name)) {
      diag && diag.push({ line: lineNo, col: 1, severity: "error", message: `"${name}" is reserved. Pick a different name.` });
      return;
    }
    if (symbols.pins.has(name)) {
      diag && diag.push({ line: lineNo, col: 1, severity: "error", message: `"${name}" is a pin name. Use a different variable name.` });
      return;
    }
    if (!symbols.vars.has(name)) {
      symbols.vars.set(name, { type: typeHint || "long", line: lineNo });
      return;
    }
    // If a var already exists and we got a better type hint, upgrade it.
    const existing = symbols.vars.get(name);

    const TYPE_RANK = {
      "bool": 1,
      "int": 2,
      "long": 3,
      "unsigned long": 4,
      "float": 5,
      "String": 6,
    };

    function rank(t){
      const key = String(t || "long").trim();
      return TYPE_RANK[key] || 3;
    }

    if (existing && typeHint) {
      const rOld = rank(existing.type);
      const rNew = rank(typeHint);

      // Warn on obvious conflicts (like turning a number into a String).
      if ((existing.type === "String" && typeHint !== "String") ||
          (existing.type !== "String" && typeHint === "String")) {
        diag && diag.push({ line: lineNo, col: 1, severity: "warning", message: `Variable "${name}" changes type (${existing.type} ↔ ${typeHint}). Arduino C++ might not like that.` });
      }

      if (rNew > rOld) existing.type = typeHint;
    }
  }

  function definePin(symbols, name, pinLiteral, lineNo, diag){
    if (!isIdentifier(name)) {
      diag.push({ line: lineNo, col: 1, severity: "error", message: "Pin name must be a valid identifier (letters, numbers, underscore)." });
      return;
    }
    if (RESERVED.has(name)) {
      diag.push({ line: lineNo, col: 1, severity: "error", message: `"${name}" is reserved. Pick a different pin name.` });
      return;
    }
    if (symbols.vars.has(name)) {
      diag.push({ line: lineNo, col: 1, severity: "error", message: `"${name}" is already a variable. Pins and variables need different names.` });
      return;
    }
    if (symbols.funcs.has(name)) {
      diag.push({ line: lineNo, col: 1, severity: "error", message: `"${name}" is already a function. Pins and functions need different names.` });
      return;
    }
    if (symbols.pins.has(name)) {
      diag.push({ line: lineNo, col: 1, severity: "error", message: `Pin "${name}" is already defined.` });
      return;
    }

    const parsed = parsePinLiteral(pinLiteral, symbols, lineNo, diag);
    if (!parsed) return;

    symbols.pins.set(name, { cpp: parsed.cpp, raw: pinLiteral, line: lineNo });
  }

  function defineFunction(symbols, name, lineNo, diag){
    if (!isIdentifier(name)) {
      diag.push({ line: lineNo, col: 1, severity: "error", message: "Function name must be a valid identifier." });
      return false;
    }
    if (RESERVED.has(name)) {
      diag.push({ line: lineNo, col: 1, severity: "error", message: `"${name}" is reserved. Pick a different function name.` });
      return false;
    }
    if (symbols.pins.has(name)) {
      diag.push({ line: lineNo, col: 1, severity: "error", message: `"${name}" is a pin name. Use a different function name.` });
      return false;
    }
    if (symbols.vars.has(name)) {
      diag.push({ line: lineNo, col: 1, severity: "error", message: `"${name}" is a variable name. Use a different function name.` });
      return false;
    }
    if (symbols.funcs.has(name)) {
      diag.push({ line: lineNo, col: 1, severity: "error", message: `Function "${name}" already exists.` });
      return false;
    }
    symbols.funcs.set(name, { line: lineNo });
    return true;
  }

  function parsePinLiteral(tok, symbols, lineNo, diag){
    const t = String(tok || "").trim();
    if (isAnalogLiteral(t)) {
      const cpp = t.toUpperCase();
      if (!BOARD.analogPins.includes(cpp)) {
        diag.push({ line: lineNo, col: 1, severity: "warning", message: `${cpp} isn't in the default ${BOARD.name.toUpperCase()} analog list.` });
      }
      return { cpp, kind: "analog" };
    }
    if (isIntLiteral(t)) {
      const n = Number(t);
      if (!Number.isFinite(n)) return null;
      if (n < BOARD.digitalPins.min || n > BOARD.digitalPins.max) {
        diag.push({ line: lineNo, col: 1, severity: "warning", message: `Pin ${n} is outside the default ${BOARD.name.toUpperCase()} range (${BOARD.digitalPins.min}..${BOARD.digitalPins.max}).` });
      }
      return { cpp: String(n), kind: "digital" };
    }
    // Could be a pin variable
    if (isIdentifier(t) && symbols && symbols.pins.has(t)) {
      return { cpp: t, kind: "pinVar" };
    }
    return null;
  }

  function resolvePinRef(tokens, symbols, lineNo, diag){
    // Accept:
    //   pin 13
    //   13
    //   A0
    //   led  (pin variable)
    if (!tokens.length) return null;

    if (tokens[0].toLowerCase() === "pin") {
      if (!tokens[1]) {
        diag.push({ line: lineNo, col: 1, severity: "error", message: 'Expected a pin after "pin". Example: pin 13' });
        return null;
      }
      const parsed = parsePinLiteral(tokens[1], symbols, lineNo, diag);
      if (!parsed) {
        diag.push({ line: lineNo, col: 1, severity: "error", message: `I don't recognize pin "${tokens[1]}". Use 0..13 or A0..A5 (or a pin name).` });
        return null;
      }
      return { cpp: parsed.cpp, consumed: 2, kind: parsed.kind };
    }

    const parsed = parsePinLiteral(tokens[0], symbols, lineNo, diag);
    if (parsed) return { cpp: parsed.cpp, consumed: 1, kind: parsed.kind };

    if (isIdentifier(tokens[0]) && symbols.pins.has(tokens[0])) {
      return { cpp: tokens[0], consumed: 1, kind: "pinVar" };
    }

    diag.push({ line: lineNo, col: 1, severity: "error", message: `Expected a pin (number, A0..A5, or a pin name). Got "${tokens[0]}".` });
    return null;
  }

  function extractIdentifiersFromExpr(expr){
    // Best-effort, not a full parser. Good enough for variables in beginner code.
    const ids = String(expr || "").match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
    return ids.filter(id => !RESERVED.has(id) && !/^A[0-5]$/i.test(id));
  }

  function parseCondition(condText, symbols, lineNo, diag){
    // Accept both:
    //   x is 0
    //   x is not 0
    //   x is greater than 10
    //   x > 10
    // Also allow "and" / "or" between comparisons.
    let t = String(condText || "").trim();
    if (!t) {
      diag.push({ line: lineNo, col: 1, severity: "error", message: "Condition is missing. Example: if button is 0 do:" });
      return null;
    }

    // Friendly phrases -> operators.
    const replacements = [
      [/\bis\s+greater\s+than\b/gi, ">"],
      [/\bis\s+less\s+than\b/gi, "<"],
      [/\bis\s+at\s+least\b/gi, ">="],
      [/\bis\s+at\s+most\b/gi, "<="],
      [/\bis\s+not\b/gi, "!="],
      [/\bequals\b/gi, "=="],
      [/\bis\b/gi, "=="],
      [/\band\b/gi, "&&"],
      [/\bor\b/gi, "||"],
    ];
    for (const [re, op] of replacements) t = t.replace(re, op);

    // Auto-declare identifiers used in condition (vars only; pins are allowed but treated as numbers).
    const ids = extractIdentifiersFromExpr(t);
    for (const id of ids) ensureVar(symbols, id, "long", lineNo, diag);

    return t;
  }

  function parseExpr(expr, symbols, lineNo, diag){
    const t = String(expr || "").trim();
    if (!t) {
      diag.push({ line: lineNo, col: 1, severity: "error", message: "Expression is missing." });
      return null;
    }

    const ids = extractIdentifiersFromExpr(t);
    for (const id of ids) {
      // If it's a pin name, allow it (it's a constant int).
      if (symbols.pins.has(id)) continue;
      ensureVar(symbols, id, "long", lineNo, diag);
    }
    return t;
  }

  // ---------------------------------------------------------------------------
  // Docs for hover (and for future "help" panels)
  // ---------------------------------------------------------------------------
  AES.docs = {
    "setup:": {
      title: "setup:",
      body: [
        "Runs once when the Arduino starts.",
        "Put pin setup (make ...) and Serial.begin here."
      ],
      example: `setup:\n  make led output\nend`
    },
    "loop:": {
      title: "loop:",
      body: [
        "Runs forever after setup() finishes.",
        "This is where your program lives."
      ],
      example: `loop:\n  turn led on\n  wait 500 ms\n  turn led off\n  wait 500 ms\nend`
    },
    "pin": {
      title: "pin NAME is VALUE",
      body: [
        "Defines a named pin so you can write readable code.",
        "VALUE can be 0..13 or A0..A5 (default UNO)."
      ],
      example: `pin led is 13\npin pot is A0`
    },
    "make": {
      title: "make PIN MODE",
      body: ["Sets the pin mode (pinMode)."],
      example: `make led output\nmake button input pullup`
    },
    "turn": {
      title: "turn PIN on/off",
      body: ["Writes HIGH/LOW to a digital pin (digitalWrite)."],
      example: `turn led on\nturn led off`
    },
    "toggle": {
      title: "toggle PIN",
      body: ["Flips the current digital pin state."],
      example: `toggle led`
    },
    "read": {
      title: "read ... into VAR",
      body: [
        "Reads a pin into a variable.",
        "Use 'read analog ...' for A0..A5."
      ],
      example: `read button into pressed\nread analog pot into value`
    },
    "wait": {
      title: "wait N ms/seconds/us",
      body: ["Pauses using delay() or delayMicroseconds(). Simple, but blocks the loop."],
      example: `wait 250 ms\nwait 1 second\nwait 50 us`
    },

    "time": {
      title: "read time into VAR",
      body: ["Stores the current millis() value into a variable."],
      example: `read time into now`
    },

    "micros": {
      title: "read micros into VAR",
      body: ["Stores the current micros() value into a variable."],
      example: `read micros into t`
    },

    "seed": {
      title: "seed random with EXPR",
      body: ["Seeds Arduino's random() generator (randomSeed)."],
      example: `seed random with 123\npick random from 0..10 into r`
    },
    "every": {
      title: "every N ms do:",
      body: [
        "Runs a block repeatedly without delay() (uses millis()).",
        "Great for blinking while still reading sensors."
      ],
      example: `every 250 ms do:\n  toggle led\nend`
    },
    "print": {
      title: "print ...",
      body: ["Prints to the Serial Monitor (Serial.println)."],
      example: `start serial at 9600\nprint \"hello\"\nprint \"x=\" and x`
    },
  };

  // ---------------------------------------------------------------------------
  // Transpiler
  // ---------------------------------------------------------------------------
  AES.extractSymbols = function extractSymbols(source){
    const src = normalizeNewlines(source);
    const lines = src.split("\n");
    const symbols = makeSymbols();
    const diagnostics = [];

    let inStructure = false;

    for (let i = 0; i < lines.length; i++){
      const lineNo = i + 1;
      const raw = lines[i];
      const code = stripComments(raw).trim();
      if (!code) continue;

      const lower = code.toLowerCase();

      if (["setup:", "loop:"].includes(lower)) { inStructure = true; continue; }
      if (lower === "end") { inStructure = false; continue; }

      // function NAME:
      {
        const m = code.match(/^function\s+([A-Za-z_]\w*)\s*:\s*$/i);
        if (m) { defineFunction(symbols, m[1], lineNo, diagnostics); continue; }
      }

      // pin NAME is VALUE
      {
        const m = code.match(/^pin\s+([A-Za-z_]\w*)\s+is\s+(.+)\s*$/i);
        if (m) {
          if (inStructure) {
            diagnostics.push({ line: lineNo, col: 1, severity: "error", message: "Pin declarations must be outside setup:/loop:/function blocks." });
          } else {
            definePin(symbols, m[1], m[2].trim(), lineNo, diagnostics);
          }
          continue;
        }
      }

      // set NAME to pin VALUE (alias)
      {
        const m = code.match(/^set\s+([A-Za-z_]\w*)\s+to\s+pin\s+(.+)\s*$/i);
        if (m) {
          if (inStructure) {
            diagnostics.push({ line: lineNo, col: 1, severity: "error", message: "Pin assignments must be outside setup:/loop:/function blocks. Use pin NAME is VALUE." });
          } else {
            definePin(symbols, m[1], m[2].trim(), lineNo, diagnostics);
          }
          continue;
        }
      }

      // variable hints (best effort)
      {
        const m = code.match(/^read\s+time\s+into\s+([A-Za-z_]\w*)\s*$/i);
        if (m) ensureVar(symbols, m[1], "unsigned long", lineNo, diagnostics);
      }
      {
        const m = code.match(/^read\s+micros\s+into\s+([A-Za-z_]\w*)\s*$/i);
        if (m) ensureVar(symbols, m[1], "unsigned long", lineNo, diagnostics);
      }
      {
        const m = code.match(/^read\s+.+\s+into\s+([A-Za-z_]\w*)\s*$/i);
        if (m) ensureVar(symbols, m[1], "int", lineNo, diagnostics);
      }
      {
        const m = code.match(/^set\s+([A-Za-z_]\w*)\s+to\s+(.+)\s*$/i);
        if (m) {
          const rhs = String(m[2] || "").trim();
          // Skip pin assignment aliases and PWM pin-writes.
          const isPinAssign = code.match(/^set\s+[A-Za-z_]\w*\s+to\s+pin\s+/i);
          const isPwmWrite  = /^pwm\b/i.test(rhs);
          if (!isPinAssign && !isPwmWrite) {
            ensureVar(symbols, m[1], inferTypeFromExpr(rhs), lineNo, diagnostics);
          }
        }
      }
    }

    return { symbols, diagnostics };
  };

  AES.transpile = function transpile(source){
    const src = normalizeNewlines(source);
    const lines = src.split("\n");

    const baseAnalysis = AES.extractSymbols(src);
    const symbols = baseAnalysis.symbols;
    const diagnostics = [...baseAnalysis.diagnostics];

    const setupBody = [];
    const loopBody = [];
    const funcBodies = new Map(); // name -> array

    // Current structure output target
    let current = null; // { type: "setup"|"loop"|"func", name?, out: array }
    const stack = [];   // block stack: setup|loop|func|if|repeat|forever|while|every|after

    let sawSetup = false;
    let sawLoop = false;
    let internalId = 0;

    function pushDiag(line, severity, message){
      diagnostics.push({ line, col: 1, severity, message });
    }

    function emit(lineNo, cppLine){
      if (!current) {
        pushDiag(lineNo, "error", "Commands must be inside setup:, loop:, or function blocks.");
        return;
      }
      current.out.push(cppLine);
    }

    function closeBlock(lineNo){
      emit(lineNo, "}");
    }

    function ensureStructureAllowed(lineNo){
      if (!current) {
        pushDiag(lineNo, "error", "Start with setup: and loop: blocks.");
        return false;
      }
      return true;
    }

    // -----------------------------------------------------------------------
    // COMMANDS TABLE (add new commands here)
    // Each handler returns true if it handled the line.
    // -----------------------------------------------------------------------
    const COMMANDS = [
      // make <pin> <mode>
      function cmd_make(code, lineNo){
        const toks = tokenize(code);
        if (!toks.length || toks[0].toLowerCase() !== "make") return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        // make pin 13 output  OR make led output
        const pinRes = resolvePinRef(toks.slice(1), symbols, lineNo, diagnostics);
        if (!pinRes) return true;

        const rest = toks.slice(1 + pinRes.consumed).map(t => t.toLowerCase());
        const restText = rest.join(" ");

        let mode = null;
        if (restText === "output") mode = "OUTPUT";
        else if (restText === "input") mode = "INPUT";
        else if (restText === "input pullup" || restText === "input_pullup" || restText === "input with pullup") mode = "INPUT_PULLUP";

        if (!mode) {
          pushDiag(lineNo, "error", 'make needs a mode: output, input, or input pullup.');
          return true;
        }

        emit(lineNo, `pinMode(${pinRes.cpp}, ${mode});`);
        return true;
      },

      // turn <pin> on/off
      function cmd_turn(code, lineNo){
        const toks = tokenize(code);
        if (!toks.length || toks[0].toLowerCase() !== "turn") return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        const pinRes = resolvePinRef(toks.slice(1), symbols, lineNo, diagnostics);
        if (!pinRes) return true;

        const rest = toks.slice(1 + pinRes.consumed);
        if (!rest.length) {
          pushDiag(lineNo, "error", 'turn needs "on" or "off".');
          return true;
        }
        const onoff = rest.join(" ").toLowerCase().trim();
        if (onoff !== "on" && onoff !== "off") {
          pushDiag(lineNo, "error", 'turn needs "on" or "off".');
          return true;
        }
        emit(lineNo, `digitalWrite(${pinRes.cpp}, ${onoff === "on" ? "HIGH" : "LOW"});`);
        return true;
      },

      // toggle <pin>
      function cmd_toggle(code, lineNo){
        const toks = tokenize(code);
        if (!toks.length || toks[0].toLowerCase() !== "toggle") return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        const pinRes = resolvePinRef(toks.slice(1), symbols, lineNo, diagnostics);
        if (!pinRes) return true;

        emit(lineNo, `digitalWrite(${pinRes.cpp}, !digitalRead(${pinRes.cpp}));`);
        return true;
      },

      // set <pin> to pwm <expr>
      function cmd_pwm(code, lineNo){
        const m = String(code).match(/^set\s+(.+?)\s+to\s+pwm\s+(.+)\s*$/i);
        if (!m) return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        const pinToks = tokenize(m[1]);
        const valExpr = m[2];

        const pinRes = resolvePinRef(pinToks, symbols, lineNo, diagnostics);
        if (!pinRes) return true;

        const expr = parseExpr(valExpr, symbols, lineNo, diagnostics);
        if (!expr) return true;

        emit(lineNo, `analogWrite(${pinRes.cpp}, ${expr});`);
        return true;
      },

      // read <pin> into var
      function cmd_read_digital(code, lineNo){
        const m = String(code).match(/^read\s+(.+?)\s+into\s+([A-Za-z_]\w*)\s*$/i);
        if (!m) return false;

        // If this is "read analog ..." let the analog handler take it.
        if (/^analog\b/i.test(m[1].trim())) return false;

        // If this is "read time ..." or "read micros ...", let the specialized handlers take it.
        const head = m[1].trim().toLowerCase();
        if (head === "time" || head === "micros") return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        const pinToks = tokenize(m[1]);
        const v = m[2];
        ensureVar(symbols, v, "int", lineNo, diagnostics);

        const pinRes = resolvePinRef(pinToks, symbols, lineNo, diagnostics);
        if (!pinRes) return true;

        emit(lineNo, `${v} = digitalRead(${pinRes.cpp});`);
        return true;
      },

      // read analog <pin> into var
      function cmd_read_analog(code, lineNo){
        const m = String(code).match(/^read\s+analog\s+(.+?)\s+into\s+([A-Za-z_]\w*)\s*$/i);
        if (!m) return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        const pinToks = tokenize(m[1]);
        const v = m[2];
        ensureVar(symbols, v, "int", lineNo, diagnostics);

        const pinRes = resolvePinRef(pinToks, symbols, lineNo, diagnostics);
        if (!pinRes) return true;

        // Guard: analogRead expects A0..A5 (or equivalent). If numeric, warn/error.
        if (pinRes.kind === "digital") {
          pushDiag(lineNo, "error", 'read analog expects A0..A5 (or a pin name set to A0..A5).');
          return true;
        }

        emit(lineNo, `${v} = analogRead(${pinRes.cpp});`);
        return true;
      },

      // read time into var  (millis)
      function cmd_read_time(code, lineNo){
        const m = String(code).match(/^read\s+time\s+into\s+([A-Za-z_]\w*)\s*$/i);
        if (!m) return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        const v = m[1];
        ensureVar(symbols, v, "unsigned long", lineNo, diagnostics);
        emit(lineNo, `${v} = millis();`);
        return true;
      },
      function cmd_read_micros(code, lineNo){
        const m = String(code).match(/^read\s+micros\s+into\s+([A-Za-z_]\w*)\s*$/i);
        if (!m) return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        const v = m[1];
        ensureVar(symbols, v, "unsigned long", lineNo, diagnostics);
        emit(lineNo, `${v} = micros();`);
        return true;
      },


      // wait N ms/seconds
      function cmd_wait(code, lineNo){
        const m = String(code).match(/^wait\s+(\d+)\s*(ms|millisecond|milliseconds|us|microsecond|microseconds|second|seconds|s)\s*$/i);
        if (!m) return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        const n = Number(m[1]);
        const unit = m[2].toLowerCase();

        if (unit === "us" || unit === "microsecond" || unit === "microseconds") {
          emit(lineNo, `delayMicroseconds(${n});`);
          return true;
        }

        const ms = (unit === "second" || unit === "seconds" || unit === "s") ? (n * 1000) : n;
        emit(lineNo, `delay(${ms});`);
        return true;
      },

      // start serial at 9600
      function cmd_serial(code, lineNo){
        const m = String(code).match(/^start\s+serial\s+at\s+(\d+)\s*$/i);
        if (!m) return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        emit(lineNo, `Serial.begin(${Number(m[1])});`);
        return true;
      },

      // print "text"
      // print var
      // print "text" and var
      function cmd_print(code, lineNo){
        const s = String(code);

        let m = s.match(/^print\s+"([^"]*)"\s*$/i);
        if (m) {
          if (!ensureStructureAllowed(lineNo)) return true;
          emit(lineNo, `Serial.println("${escapeCppString(m[1])}");`);
          return true;
        }

        m = s.match(/^print\s+"([^"]*)"\s+and\s+(.+)\s*$/i);
        if (m) {
          if (!ensureStructureAllowed(lineNo)) return true;
          const expr = parseExpr(m[2], symbols, lineNo, diagnostics);
          if (!expr) return true;
          emit(lineNo, `Serial.print("${escapeCppString(m[1])}");`);
          emit(lineNo, `Serial.println(${expr});`);
          return true;
        }

        m = s.match(/^print\s+(.+)\s*$/i);
        if (m) {
          if (!ensureStructureAllowed(lineNo)) return true;
          const expr = parseExpr(m[1], symbols, lineNo, diagnostics);
          if (!expr) return true;
          emit(lineNo, `Serial.println(${expr});`);
          return true;
        }

        return false;
      },

      // set var to expr
      function cmd_set(code, lineNo){
        // Ignore pin assignment alias (handled in extractSymbols only, and must be top-level).
        if (/^set\s+[A-Za-z_]\w*\s+to\s+pin\s+/i.test(code)) return false;

        const m = String(code).match(/^set\s+([A-Za-z_]\w*)\s+to\s+(.+)\s*$/i);
        if (!m) return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        const v = m[1];
        const exprRaw = m[2].trim();

        const typeHint = inferTypeFromExpr(exprRaw);
        ensureVar(symbols, v, typeHint, lineNo, diagnostics);

        if (/^"([^"\\]|\\.)*"$/.test(exprRaw)) {
          // String literal
          emit(lineNo, `${v} = "${escapeCppString(exprRaw.slice(1, -1))}";`);
          return true;
        }

        const expr = parseExpr(exprRaw, symbols, lineNo, diagnostics);
        if (!expr) return true;

        emit(lineNo, `${v} = ${expr};`);
        return true;
      },

      // change var by expr
      function cmd_change(code, lineNo){
        const m = String(code).match(/^change\s+([A-Za-z_]\w*)\s+by\s+(.+)\s*$/i);
        if (!m) return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        const v = m[1];
        const expr = parseExpr(m[2], symbols, lineNo, diagnostics);
        if (!expr) return true;

        ensureVar(symbols, v, "long", lineNo, diagnostics);
        emit(lineNo, `${v} += (${expr});`);
        return true;
      },

      // map src from a..b to c..d into dest
      function cmd_map(code, lineNo){
        const m = String(code).match(/^map\s+([A-Za-z_]\w*)\s+from\s+(-?\d+\.\.-?\d+)\s+to\s+(-?\d+\.\.-?\d+)\s+into\s+([A-Za-z_]\w*)\s*$/i);
        if (!m) return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        const srcVar = m[1];
        const inR = parseRange(m[2]);
        const outR = parseRange(m[3]);
        const dest = m[4];

        if (!inR || !outR) {
          pushDiag(lineNo, "error", 'Bad range. Use like 0..1023');
          return true;
        }

        ensureVar(symbols, srcVar, "long", lineNo, diagnostics);
        ensureVar(symbols, dest, "long", lineNo, diagnostics);

        emit(lineNo, `${dest} = map(${srcVar}, ${inR[0]}, ${inR[1]}, ${outR[0]}, ${outR[1]});`);
        return true;
      },

      // limit var to lo..hi
      function cmd_limit(code, lineNo){
        const m = String(code).match(/^limit\s+([A-Za-z_]\w*)\s+to\s+(-?\d+)\.\.(-?\d+)\s*$/i);
        if (!m) return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        const v = m[1];
        const lo = Number(m[2]);
        const hi = Number(m[3]);
        ensureVar(symbols, v, "long", lineNo, diagnostics);

        emit(lineNo, `if (${v} < ${lo}) ${v} = ${lo};`);
        emit(lineNo, `if (${v} > ${hi}) ${v} = ${hi};`);
        return true;
      },

      // pick random from a..b into var
      function cmd_random(code, lineNo){
        let m = String(code).match(/^pick\s+random\s+from\s+(-?\d+)\.\.(-?\d+)\s+into\s+([A-Za-z_]\w*)\s*$/i);
        if (!m) m = String(code).match(/^pick\s+a\s+random\s+number\s+from\s+(-?\d+)\.\.(-?\d+)\s+into\s+([A-Za-z_]\w*)\s*$/i);
        if (!m) return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        const a = Number(m[1]);
        const b = Number(m[2]);
        const v = m[3];
        ensureVar(symbols, v, "long", lineNo, diagnostics);

        const lo = Math.min(a,b);
        const hi = Math.max(a,b);
        emit(lineNo, `${v} = random(${lo}, ${hi + 1});`);
        return true;
      },

      // seed random with <expr>  (randomSeed)
      function cmd_seed_random(code, lineNo){
        let m = String(code).match(/^seed\s+random\s+with\s+(.+)\s*$/i);
        if (!m) m = String(code).match(/^random\s+seed\s+(.+)\s*$/i);
        if (!m) return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        const expr = parseExpr(m[1], symbols, lineNo, diagnostics);
        if (!expr) return true;

        emit(lineNo, `randomSeed(${expr});`);
        return true;
      },

      // play tone 440 on pin 8 | play tone 440 on buzzer
      function cmd_tone(code, lineNo){
        const m = String(code).match(/^play\s+tone\s+(.+?)\s+on\s+(.+)\s*$/i);
        if (!m) return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        const freqExpr = parseExpr(m[1], symbols, lineNo, diagnostics);
        if (!freqExpr) return true;

        const pinRes = resolvePinRef(tokenize(m[2]), symbols, lineNo, diagnostics);
        if (!pinRes) return true;

        emit(lineNo, `tone(${pinRes.cpp}, ${freqExpr});`);
        return true;
      },

      function cmd_noTone(code, lineNo){
        const m = String(code).match(/^stop\s+tone\s+on\s+(.+)\s*$/i);
        if (!m) return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        const pinRes = resolvePinRef(tokenize(m[1]), symbols, lineNo, diagnostics);
        if (!pinRes) return true;

        emit(lineNo, `noTone(${pinRes.cpp});`);
        return true;
      },

      // call functionName
      function cmd_call(code, lineNo){
        const m = String(code).match(/^call\s+([A-Za-z_]\w*)\s*$/i);
        if (!m) return false;

        if (!ensureStructureAllowed(lineNo)) return true;

        const fn = m[1];
        if (!symbols.funcs.has(fn)) {
          pushDiag(lineNo, "warning", `Function "${fn}" isn't defined (yet). Did you mean to write "function ${fn}:"?`);
        }
        emit(lineNo, `${fn}();`);
        return true;
      },
    ];

    // -----------------------------------------------------------------------
    // Walk lines
    // -----------------------------------------------------------------------
    for (let i = 0; i < lines.length; i++){
      const lineNo = i + 1;
      const raw = lines[i];
      const code = stripComments(raw).trim();
      if (!code) continue;

      const lower = code.toLowerCase();

      // Structure openers
      if (lower === "setup:") {
        if (current) { pushDiag(lineNo, "error", "setup: can't be inside another block."); continue; }
        sawSetup = true;
        current = { type: "setup", out: setupBody };
        stack.push({ type: "setup" });
        continue;
      }
      if (lower === "loop:") {
        if (current) { pushDiag(lineNo, "error", "loop: can't be inside another block."); continue; }
        sawLoop = true;
        current = { type: "loop", out: loopBody };
        stack.push({ type: "loop" });
        continue;
      }
      {
        const m = code.match(/^function\s+([A-Za-z_]\w*)\s*:\s*$/i);
        if (m) {
          if (current) { pushDiag(lineNo, "error", "Functions must be top-level (not inside setup/loop)."); continue; }
          const name = m[1];
          // Function symbol already collected; if invalid, it would have a diagnostic already.
          if (!symbols.funcs.has(name)) defineFunction(symbols, name, lineNo, diagnostics);
          const body = [];
          funcBodies.set(name, body);
          current = { type: "func", name, out: body };
          stack.push({ type: "func", name });
          continue;
        }
      }

      // Pin declarations are top-level.
      // - At top-level: we ignore them here (extractSymbols already recorded them).
      // - Inside setup/loop/function: we error (pins should be declared once, at the top).
      if (/^pin\s+/i.test(code) || /^set\s+[A-Za-z_]\w*\s+to\s+pin\s+/i.test(code)) {
        if (current) {
          pushDiag(lineNo, "error", "Pin declarations must be outside setup:/loop:/function blocks.");
        }
        continue;
      }

      // Control blocks
      {
        const m = code.match(/^if\s+(.+)\s+do:\s*$/i);
        if (m) {
          if (!ensureStructureAllowed(lineNo)) continue;
          const cond = parseCondition(m[1], symbols, lineNo, diagnostics);
          if (!cond) continue;
          emit(lineNo, `if (${cond}) {`);
          stack.push({ type: "if", hasElse: false });
          continue;
        }
      }
      if (lower === "otherwise do:" || lower === "otherwise:" ) {
        if (!ensureStructureAllowed(lineNo)) continue;
        const top = stack[stack.length - 1];
        if (!top || top.type !== "if") {
          pushDiag(lineNo, "error", "otherwise do: must be inside an if block.");
          continue;
        }
        if (top.hasElse) {
          pushDiag(lineNo, "error", "This if already has an otherwise block.");
          continue;
        }
        emit(lineNo, `} else {`);
        top.hasElse = true;
        continue;
      }
      {
        const m = code.match(/^repeat\s+(-?\d+)\s+times\s+do:\s*$/i);
        if (m) {
          if (!ensureStructureAllowed(lineNo)) continue;
          const n = Number(m[1]);
          if (!Number.isFinite(n) || n < 0) { pushDiag(lineNo, "error", "repeat count must be a non-negative number."); continue; }
          internalId++;
          const idx = `__i${internalId}`;
          emit(lineNo, `for (int ${idx} = 0; ${idx} < ${n}; ${idx}++) {`);
          stack.push({ type: "repeat" });
          continue;
        }
      }
      if (lower === "forever do:") {
        if (!ensureStructureAllowed(lineNo)) continue;
        emit(lineNo, `while (true) {`);
        stack.push({ type: "forever" });
        continue;
      }
      {
        const m = code.match(/^while\s+(.+)\s+do:\s*$/i);
        if (m) {
          if (!ensureStructureAllowed(lineNo)) continue;
          const cond = parseCondition(m[1], symbols, lineNo, diagnostics);
          if (!cond) continue;
          emit(lineNo, `while (${cond}) {`);
          stack.push({ type: "while" });
          continue;
        }
      }

      // every N ms/seconds do:
      {
        const m = code.match(/^every\s+(\d+)\s*(ms|millisecond|milliseconds|second|seconds|s)\s+do:\s*$/i);
        if (m) {
          if (!ensureStructureAllowed(lineNo)) continue;
          const n = Number(m[1]);
          const unit = m[2].toLowerCase();
          const interval = (unit === "second" || unit === "seconds" || unit === "s") ? (n * 1000) : n;
          internalId++;
          const id = internalId;
          const last = `__every_${id}_last`;
          emit(lineNo, `static unsigned long ${last} = 0;`);
          emit(lineNo, `if (millis() - ${last} >= ${interval}UL) {`);
          emit(lineNo, `${last} += ${interval}UL;`);
          stack.push({ type: "every" });
          continue;
        }
      }

      // after N ms/seconds do:
      {
        const m = code.match(/^after\s+(\d+)\s*(ms|millisecond|milliseconds|second|seconds|s)\s+do:\s*$/i);
        if (m) {
          if (!ensureStructureAllowed(lineNo)) continue;
          const n = Number(m[1]);
          const unit = m[2].toLowerCase();
          const delayMs = (unit === "second" || unit === "seconds" || unit === "s") ? (n * 1000) : n;
          internalId++;
          const id = internalId;
          const done = `__after_${id}_done`;
          const start = `__after_${id}_start`;
          emit(lineNo, `static bool ${done} = false;`);
          emit(lineNo, `static unsigned long ${start} = millis();`);
          emit(lineNo, `if (!${done} && millis() - ${start} >= ${delayMs}UL) {`);
          emit(lineNo, `${done} = true;`);
          stack.push({ type: "after" });
          continue;
        }
      }

      // end
      if (lower === "end") {
        if (!stack.length) { pushDiag(lineNo, "error", 'Found "end" but there is no open block.'); continue; }
        const top = stack.pop();

        if (["if","repeat","forever","while","every","after"].includes(top.type)) {
          closeBlock(lineNo);
          continue;
        }

        if (["setup","loop","func"].includes(top.type)) {
          // closing structure
          current = null;
          continue;
        }

        pushDiag(lineNo, "error", `Unknown block type "${top.type}".`);
        continue;
      }

      // If we got here and are not inside a structure, it's an error.
      if (!current) {
        pushDiag(lineNo, "error", 'Commands must be inside setup:, loop:, or function blocks.');
        continue;
      }

      // Commands
      let handled = false;
      for (const h of COMMANDS){
        if (h(code, lineNo)) { handled = true; break; }
      }
      if (!handled){
        pushDiag(lineNo, "error", `Unknown command: "${code}"`);
      }
    }

    // Unclosed blocks
    if (stack.length){
      const top = stack[stack.length - 1];
      pushDiag(lines.length, "error", `Unclosed block "${top.type}". Add an "end".`);
    }

    if (!sawSetup) pushDiag(1, "error", 'Missing "setup:" block.');
    if (!sawLoop) pushDiag(1, "error", 'Missing "loop:" block.');

    // Build globals:
    const pinDecls = [];
    for (const [name, info] of symbols.pins.entries()){
      pinDecls.push(`const int ${name} = ${info.cpp};`);
    }

    const varDecls = [];
    for (const [name, info] of symbols.vars.entries()){
      // "unsigned long" is valid, keep as-is. Otherwise default to long.
      const t = info.type || "long";
      let init = "0";
      if (t === "bool") init = "false";
      if (t === "String") init = "\"\"";
      if (t === "float") init = "0.0";
      if (t === "unsigned long") init = "0UL";
      varDecls.push(`${t} ${name} = ${init};`);
    }

    // Prototypes for user functions
    const prototypes = [];
    for (const [name] of funcBodies.entries()) prototypes.push(`void ${name}();`);

    // Function bodies
    function indentCpp(lines, baseIndent){
      let ind = baseIndent;
      const out = [];
      for (const raw of lines){
        const t = String(raw || "").trim();
        if (!t) { out.push(""); continue; }

        // Outdent lines that start with "}"
        if (t.startsWith("}")) ind = Math.max(0, ind - 1);

        out.push("  ".repeat(ind) + t);

        // Indent after "{"
        if (t.endsWith("{")) ind += 1;
      }
      return out.join("\n");
    }

    const fnText = [];
    for (const [name, body] of funcBodies.entries()){
      fnText.push(`void ${name}() {`);
      const bodyText = indentCpp(body, 1);
      if (bodyText) fnText.push(bodyText);
      fnText.push(`}`);
      fnText.push("");
    }

    const header = `// Generated by Arduino EasyScript (AES) v${AES.version}
// This file uses ONLY Arduino core functions (no external libraries).

`;

    const cpp = header +
      (prototypes.length ? prototypes.join("\n") + "\n\n" : "") +
      (pinDecls.length ? pinDecls.join("\n") + "\n\n" : "") +
      (varDecls.length ? varDecls.join("\n") + "\n\n" : "") +
      (fnText.length ? fnText.join("\n") : "") +
      `void setup() {\n${indentCpp(setupBody, 1)}\n}\n\n` +
      `void loop() {\n${indentCpp(loopBody, 1)}\n}\n`;
    return { cpp, diagnostics, symbols };
  };

  // ---------------------------------------------------------------------------
  // Formatter
  // ---------------------------------------------------------------------------
  AES.format = function format(source){
    const src = normalizeNewlines(source);
    const lines = src.split("\n");
    const out = [];
    let indent = 0;

    const IND = "  ";

    function isBlockOpener(code){
      const c = code.trim().toLowerCase();
      if (!c) return false;
      if (c.endsWith(":")) return true;
      if (c.endsWith("do:")) return true;
      return false;
    }

    function isOutdentLine(code){
      const c = code.trim().toLowerCase();
      if (c === "end") return true;
      if (c === "otherwise do:" || c === "otherwise:") return true;
      return false;
    }

    for (const raw of lines){
      const { code, comment } = splitLineComment(raw);
      const trimmed = code.trim();

      if (!trimmed && !comment.trim()){
        out.push("");
        continue;
      }

      let localIndent = indent;
      if (isOutdentLine(trimmed)) localIndent = Math.max(0, indent - 1);

      // Normalize spacing for common keywords (tiny polish; keep minimal).
      let normalized = trimmed
        .replace(/\s+$/g, "")
        .replace(/\s{2,}/g, " ");

      // Keep comment attached (if any)
      let lineText = (IND.repeat(localIndent)) + normalized;
      if (comment.trim()){
        const gap = normalized ? "  " : "";
        lineText += gap + comment.trim();
      }

      out.push(lineText);

      // Update indent after writing
      if (trimmed.toLowerCase() === "end") {
        indent = Math.max(0, indent - 1);
        continue;
      }
      if (trimmed.toLowerCase() === "otherwise do:" || trimmed.toLowerCase() === "otherwise:") {
        indent = Math.max(0, indent - 1) + 1;
        continue;
      }
      if (isBlockOpener(trimmed)) indent += 1;
    }

    return out.join("\n").replace(/\s+$/g, "") + "\n";
  };

  // expose
  window.AES = AES;
})();
