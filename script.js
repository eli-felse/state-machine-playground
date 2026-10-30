(function () {
  'use strict';

  var STORAGE_KEY = 'smp_definition_v1';
  var HIDE_REPEATS_KEY = 'smp_hide_repeats_v1';

  var PALETTE = [
    '#4f5bd5', '#e0575b', '#3fa66a', '#e0a13f',
    '#8f45cc', '#3ba8b5', '#d5578f', '#7a8c3d',
    '#4a6ccc', '#c96b2f'
  ];

  // Fill used for states that cannot be reached from the initial state.
  // White text on this red has a contrast ratio of about 5.6:1.
  var UNREACHABLE_COLOR = '#c62828';

  var EXAMPLES = {
    traffic:
      '# Traffic light\n' +
      'initial: red\n' +
      'red -> green : timer\n' +
      'green -> yellow : timer\n' +
      'yellow -> red : timer\n',
    vending:
      '# Vending machine\n' +
      'initial: idle\n' +
      'idle -> hasCoin : insertCoin\n' +
      'hasCoin -> idle : refund\n' +
      'hasCoin -> dispensing : selectItem\n' +
      'dispensing -> idle : done\n',
    toggle:
      '# Toggle switch\n' +
      'initial: off\n' +
      'off -> on : flip\n' +
      'on -> off : flip\n',
    login:
      '# Login flow\n' +
      'initial: loggedOut\n' +
      'loggedOut -> checking : submit\n' +
      'checking -> loggedIn : success\n' +
      'checking -> loggedOut : failure\n' +
      'loggedIn -> loggedOut : logout\n'
  };

  // ---------- DOM references ----------
  var els = {
    input: document.getElementById('definition-input'),
    exampleSelect: document.getElementById('example-select'),
    clearBtn: document.getElementById('clear-btn'),
    saveIndicator: document.getElementById('save-indicator'),
    errorList: document.getElementById('error-list'),
    warningList: document.getElementById('warning-list'),
    svg: document.getElementById('graph-svg'),
    graphEmpty: document.getElementById('graph-empty'),
    stateCount: document.getElementById('state-count'),
    currentStateLabel: document.getElementById('current-state-label'),
    transitionButtons: document.getElementById('transition-buttons'),
    eventForm: document.getElementById('event-form'),
    eventInput: document.getElementById('event-input'),
    simLog: document.getElementById('sim-log'),
    hideRepeats: document.getElementById('hide-repeats-toggle'),
    resetSimBtn: document.getElementById('reset-sim-btn')
  };

  // ---------- Simulation state ----------
  var model = null;      // parsed model
  var currentState = null;
  var logData = [];      // full history; the filter only changes how it is displayed
  var saveTimer = null;

  // ---------- Parser ----------
  function parseDefinition(text) {
    var lines = text.split('\n');
    var stateOrder = [];
    var stateSet = {};
    var transitions = [];
    var errors = [];
    var initial = null;

    function ensureState(name) {
      if (!stateSet[name]) {
        stateSet[name] = true;
        stateOrder.push(name);
      }
    }

    lines.forEach(function (raw, idx) {
      var lineNum = idx + 1;
      var line = raw.trim();
      if (!line || line.indexOf('#') === 0 || line.indexOf('//') === 0) return;

      var initialMatch = line.match(/^initial\s*:\s*(.+)$/i);
      if (initialMatch) {
        var name = initialMatch[1].trim();
        if (!name) {
          errors.push({ line: lineNum, message: 'Missing state name after "initial:"' });
          return;
        }
        initial = name;
        ensureState(name);
        return;
      }

      var arrowIdx = line.indexOf('->');
      if (arrowIdx !== -1) {
        var from = line.slice(0, arrowIdx).trim();
        var rest = line.slice(arrowIdx + 2).trim();
        var to = rest;
        var event = '';
        var colonIdx = rest.indexOf(':');
        if (colonIdx !== -1) {
          to = rest.slice(0, colonIdx).trim();
          event = rest.slice(colonIdx + 1).trim();
        }
        if (!from || !to) {
          errors.push({ line: lineNum, message: 'Could not parse transition: "' + raw.trim() + '"' });
          return;
        }
        ensureState(from);
        ensureState(to);
        transitions.push({ from: from, to: to, event: event, line: lineNum });
        return;
      }

      if (/^[^\s:]+$/.test(line)) {
        ensureState(line);
        return;
      }

      errors.push({ line: lineNum, message: 'Could not parse line: "' + raw.trim() + '"' });
    });

    if (!initial && stateOrder.length > 0) {
      initial = stateOrder[0];
    }

    var states = stateOrder.map(function (name, i) {
      return { name: name, color: PALETTE[i % PALETTE.length] };
    });

    var unreachable = findUnreachable(stateOrder, transitions, initial);
    var unreachableSet = {};
    unreachable.forEach(function (name) { unreachableSet[name] = true; });
    states.forEach(function (s) { s.unreachable = !!unreachableSet[s.name]; });

    return {
      states: states,
      transitions: transitions,
      errors: errors,
      initial: initial,
      unreachable: unreachable
    };
  }

  // Breadth-first search from the initial state. Returns the names of all
  // states (in declaration order) that no sequence of transitions can reach.
  function findUnreachable(stateNames, transitions, initial) {
    if (!initial) return [];
    var next = {};
    transitions.forEach(function (t) {
      (next[t.from] = next[t.from] || []).push(t.to);
    });
    var seen = {};
    seen[initial] = true;
    var queue = [initial];
    while (queue.length) {
      var cur = queue.shift();
      (next[cur] || []).forEach(function (to) {
        if (!seen[to]) {
          seen[to] = true;
          queue.push(to);
        }
      });
    }
    return stateNames.filter(function (name) { return !seen[name]; });
  }

  // ---------- Colour contrast helpers ----------
  function relativeLuminance(hex) {
    var channels = [1, 3, 5].map(function (i) {
      var v = parseInt(hex.substr(i, 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function contrastRatio(hexA, hexB) {
    var a = relativeLuminance(hexA);
    var b = relativeLuminance(hexB);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  // Picks black-ish or white text, whichever is more readable on the fill.
  function readableTextColor(fillHex) {
    return contrastRatio(fillHex, '#ffffff') >= contrastRatio(fillHex, '#111111') ? '#ffffff' : '#111111';
  }

  // ---------- Rendering: errors ----------
  function renderErrors(errors) {
    els.errorList.innerHTML = '';
    errors.forEach(function (err) {
      var div = document.createElement('div');
      div.className = 'error-item';
      div.textContent = 'Line ' + err.line + ': ' + err.message;
      els.errorList.appendChild(div);
    });
  }

  // ---------- Rendering: warnings ----------
  function renderWarnings(unreachable, initial) {
    els.warningList.innerHTML = '';
    unreachable.forEach(function (name) {
      var div = document.createElement('div');
      div.className = 'warning-item';
      div.textContent = 'Warning: state "' + name + '" is unreachable from the start state "' + initial + '".';
      els.warningList.appendChild(div);
    });
  }

  // ---------- Rendering: graph ----------
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) {
      el.setAttribute(k, attrs[k]);
    }
    return el;
  }

  function computeLayout(states, width, height) {
    var cx = width / 2;
    var cy = height / 2;
    var r = Math.max(60, Math.min(width, height) / 2 - 60);
    var n = states.length;
    var positions = {};
    if (n === 1) {
      positions[states[0].name] = { x: cx, y: cy };
    } else {
      states.forEach(function (s, i) {
        var angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        positions[s.name] = {
          x: cx + r * Math.cos(angle),
          y: cy + r * Math.sin(angle)
        };
      });
    }
    return positions;
  }

  function groupEdgesForDisplay(transitions) {
    var order = [];
    var groups = {};
    transitions.forEach(function (t) {
      var key = t.from + '\u0000' + t.to;
      if (!groups[key]) {
        groups[key] = { from: t.from, to: t.to, events: [] };
        order.push(key);
      }
      groups[key].events.push(t.event);
    });
    return order.map(function (key) { return groups[key]; });
  }

  function renderGraph() {
    var svg = els.svg;
    svg.innerHTML = '';

    if (!model || model.states.length === 0) {
      els.graphEmpty.style.display = 'block';
      els.stateCount.textContent = '';
      return;
    }
    els.graphEmpty.style.display = 'none';

    var vb = svg.viewBox.baseVal;
    var width = vb && vb.width ? vb.width : 600;
    var height = vb && vb.height ? vb.height : 420;

    var defs = svgEl('defs', {});
    var marker = svgEl('marker', {
      id: 'arrowhead', viewBox: '0 0 10 10', refX: '8', refY: '5',
      markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse'
    });
    marker.appendChild(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', 'class': 'arrowhead-shape' }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    var positions = computeLayout(model.states, width, height);
    var edgeGroups = groupEdgesForDisplay(model.transitions);

    // pair -> count of edges between the same unordered pair, to decide curvature
    var pairHasReverse = {};
    edgeGroups.forEach(function (g) {
      if (g.from === g.to) return;
      pairHasReverse[g.from + '\u0000' + g.to] = true;
    });

    var edgeLayer = svgEl('g', { 'class': 'edge-layer' });
    var nodeLayer = svgEl('g', { 'class': 'node-layer' });

    edgeGroups.forEach(function (g) {
      var label = g.events.filter(Boolean).join(', ');
      if (g.from === g.to) {
        drawSelfLoop(edgeLayer, positions[g.from], g.from, label, width, height);
      } else {
        var reverseKey = g.to + '\u0000' + g.from;
        var bend = pairHasReverse[reverseKey] ? 28 : 0;
        drawEdge(edgeLayer, positions[g.from], positions[g.to], label, bend);
      }
    });

    var nodeRadius = model.states.length > 8 ? 26 : 32;
    model.states.forEach(function (s) {
      drawNode(nodeLayer, s, positions[s.name], nodeRadius);
    });

    svg.appendChild(edgeLayer);
    svg.appendChild(nodeLayer);

    els.stateCount.textContent = model.states.length + ' state' + (model.states.length === 1 ? '' : 's') +
      ', ' + model.transitions.length + ' transition' + (model.transitions.length === 1 ? '' : 's') +
      (model.unreachable.length ? ', ' + model.unreachable.length + ' unreachable' : '');
  }

  function drawEdge(layer, p1, p2, label, bend) {
    var dx = p2.x - p1.x, dy = p2.y - p1.y;
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / dist, ny = dx / dist; // unit normal

    var nodeR = 32;
    var startX = p1.x + (dx / dist) * nodeR;
    var startY = p1.y + (dy / dist) * nodeR;
    var endX = p2.x - (dx / dist) * (nodeR + 6);
    var endY = p2.y - (dy / dist) * (nodeR + 6);

    var midX = (startX + endX) / 2 + nx * bend;
    var midY = (startY + endY) / 2 + ny * bend;

    var d = 'M ' + startX + ' ' + startY + ' Q ' + midX + ' ' + midY + ' ' + endX + ' ' + endY;
    var path = svgEl('path', { d: d, 'class': 'edge-path' });
    layer.appendChild(path);

    if (label) {
      addEdgeLabel(layer, midX, midY, label);
    }
  }

  function drawSelfLoop(layer, p, name, label, width, height) {
    // loop bulges away from the center of the canvas
    var cx = width / 2, cy = height / 2;
    var dx = p.x - cx, dy = p.y - cy;
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / dist, uy = dy / dist;
    var nodeR = 32;

    var startX = p.x + ux * nodeR * 0.6 - uy * nodeR * 0.5;
    var startY = p.y + uy * nodeR * 0.6 + ux * nodeR * 0.5;
    var endX = p.x + ux * nodeR * 0.6 + uy * nodeR * 0.5;
    var endY = p.y + uy * nodeR * 0.6 - ux * nodeR * 0.5;
    var loopX = p.x + ux * (nodeR + 38);
    var loopY = p.y + uy * (nodeR + 38);

    var d = 'M ' + startX + ' ' + startY +
      ' C ' + loopX + ' ' + loopY + ', ' + loopX + ' ' + loopY + ', ' + endX + ' ' + endY;
    var path = svgEl('path', { d: d, 'class': 'edge-path' });
    layer.appendChild(path);

    if (label) {
      addEdgeLabel(layer, loopX, loopY, label);
    }
  }

  function addEdgeLabel(layer, x, y, text) {
    var padding = 3;
    var estWidth = Math.max(14, text.length * 6.2);
    var bg = svgEl('rect', {
      x: x - estWidth / 2 - padding,
      y: y - 8,
      width: estWidth + padding * 2,
      height: 14,
      rx: 3,
      'class': 'edge-label-bg'
    });
    var t = svgEl('text', { x: x, y: y + 2, 'class': 'edge-label', 'text-anchor': 'middle' });
    t.textContent = text;
    layer.appendChild(bg);
    layer.appendChild(t);
  }

  function drawNode(layer, state, pos, r) {
    var g = svgEl('g', {
      'class': 'state-node' + (state.name === currentState ? ' is-active' : '') +
        (state.name === (model && model.initial) ? ' is-initial' : '') +
        (state.unreachable ? ' is-unreachable' : ''),
      'transform': 'translate(' + pos.x + ',' + pos.y + ')'
    });
    var fill = state.unreachable ? UNREACHABLE_COLOR : state.color;
    var circle = svgEl('circle', { r: r, fill: fill });
    g.appendChild(circle);

    if (state.name === (model && model.initial)) {
      g.appendChild(svgEl('circle', { r: r + 5, fill: 'none', 'class': 'initial-ring' }));
    }

    var text = svgEl('text', { fill: readableTextColor(fill) });
    var label = state.name.length > 12 ? state.name.slice(0, 11) + '\u2026' : state.name;
    text.textContent = label;
    g.appendChild(text);

    if (state.unreachable) {
      // Warning badge so the state is flagged by more than colour alone.
      var badge = svgEl('g', { 'class': 'warn-badge', transform: 'translate(' + (r * 0.75) + ',' + (-r * 0.75) + ')' });
      badge.appendChild(svgEl('circle', { r: 9 }));
      var bang = svgEl('text', {});
      bang.textContent = '!';
      badge.appendChild(bang);
      g.appendChild(badge);

      var title = svgEl('title', {});
      title.textContent = 'Unreachable from the start state "' + model.initial + '"';
      g.appendChild(title);
    }

    layer.appendChild(g);
  }

  // ---------- Simulation ----------
  function resetSimulation() {
    currentState = model && model.initial ? model.initial : null;
    logData = [];
    renderLog();
    updateSimUI();
  }

  function updateSimUI() {
    els.currentStateLabel.textContent = currentState || '\u2014';
    renderTransitionButtons();
    renderGraph();
  }

  function renderTransitionButtons() {
    els.transitionButtons.innerHTML = '';
    if (!model || !currentState) return;

    var outgoing = model.transitions.filter(function (t) { return t.from === currentState; });
    if (outgoing.length === 0) {
      var span = document.createElement('span');
      span.className = 'no-transitions';
      span.textContent = 'No outgoing transitions from this state.';
      els.transitionButtons.appendChild(span);
      return;
    }

    outgoing.forEach(function (t) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'transition-btn';
      var eventLabel = t.event ? t.event : '(no event)';
      btn.textContent = eventLabel + ' \u2192 ' + t.to;
      btn.addEventListener('click', function () {
        applyTransition(t);
      });
      els.transitionButtons.appendChild(btn);
    });
  }

  function applyTransition(t) {
    var from = currentState;
    currentState = t.to;
    logEntry(from + ' \u2014' + (t.event ? t.event : '\u03b5') + '\u2192 ' + t.to, false, t.event);
    updateSimUI();
  }

  function handleEventInput(eventName) {
    if (!model || !currentState) return;
    var match = model.transitions.filter(function (t) {
      return t.from === currentState && t.event === eventName;
    })[0];
    if (match) {
      applyTransition(match);
    } else {
      logEntry('No transition for event "' + eventName + '" from state "' + currentState + '"', true, eventName);
    }
  }

  function logEntry(text, isError, eventName) {
    logData.push({ text: text, isError: !!isError, event: eventName });
    renderLog();
  }

  // Re-draws the history list from logData. When "hide repeated events" is on,
  // an entry is folded into the previous one if it has the same event and the
  // same outcome (move vs. no-match), and a "×N" badge shows how many were folded.
  function renderLog() {
    var hide = els.hideRepeats.checked;
    var rows = [];
    var lastKey = null;

    logData.forEach(function (entry) {
      var key = (entry.isError ? 'error' : 'move') + '\u0000' + entry.event;
      if (hide && rows.length && key === lastKey) {
        rows[rows.length - 1].count += 1;
        return;
      }
      rows.push({ entry: entry, count: 1 });
      lastKey = key;
    });

    els.simLog.innerHTML = '';
    rows.forEach(function (row) {
      var li = document.createElement('li');
      li.textContent = row.entry.text;
      if (row.entry.isError) li.className = 'log-error';
      if (row.count > 1) {
        var badge = document.createElement('span');
        badge.className = 'log-repeat-count';
        badge.textContent = '\u00d7' + row.count;
        badge.title = row.count + ' consecutive repeats of this event';
        li.appendChild(badge);
      }
      els.simLog.appendChild(li);
    });
    els.simLog.scrollTop = els.simLog.scrollHeight;
  }

  // ---------- Wiring ----------
  function rebuildFromText(text) {
    model = parseDefinition(text);
    renderErrors(model.errors);
    renderWarnings(model.unreachable, model.initial);
    resetSimulation();
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    els.saveIndicator.textContent = '';
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(STORAGE_KEY, els.input.value);
        els.saveIndicator.textContent = 'Saved';
        setTimeout(function () {
          if (els.saveIndicator.textContent === 'Saved') els.saveIndicator.textContent = '';
        }, 1200);
      } catch (e) {
        els.saveIndicator.textContent = 'Could not save';
      }
    }, 350);
  }

  els.input.addEventListener('input', function () {
    rebuildFromText(els.input.value);
    scheduleSave();
  });

  els.exampleSelect.addEventListener('change', function () {
    var key = els.exampleSelect.value;
    if (!key || !EXAMPLES[key]) return;
    els.input.value = EXAMPLES[key];
    rebuildFromText(els.input.value);
    scheduleSave();
    els.exampleSelect.value = '';
  });

  els.clearBtn.addEventListener('click', function () {
    els.input.value = '';
    rebuildFromText('');
    scheduleSave();
    els.input.focus();
  });

  els.hideRepeats.addEventListener('change', function () {
    try {
      localStorage.setItem(HIDE_REPEATS_KEY, els.hideRepeats.checked ? '1' : '0');
    } catch (e) { /* preference just won't persist */ }
    renderLog();
  });

  els.resetSimBtn.addEventListener('click', function () {
    resetSimulation();
  });

  els.eventForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var val = els.eventInput.value.trim();
    if (!val) return;
    handleEventInput(val);
    els.eventInput.value = '';
  });

  window.addEventListener('resize', function () {
    renderGraph();
  });

  // ---------- Init ----------
  function init() {
    var saved = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
      els.hideRepeats.checked = localStorage.getItem(HIDE_REPEATS_KEY) === '1';
    } catch (e) {
      saved = null;
    }
    var initialText = (saved !== null) ? saved : EXAMPLES.traffic;
    els.input.value = initialText;
    rebuildFromText(initialText);
  }

  init();
})();
