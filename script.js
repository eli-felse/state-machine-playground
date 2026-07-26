(function () {
  'use strict';

  var STORAGE_KEY = 'smp_definition_v1';

  var PALETTE = [
    '#4f5bd5', '#e0575b', '#3fa66a', '#e0a13f',
    '#a15fd6', '#3ba8b5', '#d5578f', '#7a8c3d',
    '#5578d6', '#c96b2f'
  ];

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
    svg: document.getElementById('graph-svg'),
    graphEmpty: document.getElementById('graph-empty'),
    stateCount: document.getElementById('state-count'),
    currentStateLabel: document.getElementById('current-state-label'),
    transitionButtons: document.getElementById('transition-buttons'),
    eventForm: document.getElementById('event-form'),
    eventInput: document.getElementById('event-input'),
    simLog: document.getElementById('sim-log'),
    resetSimBtn: document.getElementById('reset-sim-btn')
  };

  // ---------- Simulation state ----------
  var model = null;      // parsed model
  var currentState = null;
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

    return { states: states, transitions: transitions, errors: errors, initial: initial };
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
    marker.appendChild(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#9aa0b4' }));
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
      ', ' + model.transitions.length + ' transition' + (model.transitions.length === 1 ? '' : 's');
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
        (state.name === (model && model.initial) ? ' is-initial' : ''),
      'transform': 'translate(' + pos.x + ',' + pos.y + ')'
    });
    var circle = svgEl('circle', { r: r, fill: state.color });
    g.appendChild(circle);

    if (state.name === (model && model.initial)) {
      var ring = svgEl('circle', { r: r + 5, fill: 'none', stroke: state.color, 'stroke-width': 1.5, 'stroke-dasharray': '3,3' });
      g.appendChild(ring);
    }

    var text = svgEl('text', {});
    var label = state.name.length > 12 ? state.name.slice(0, 11) + '\u2026' : state.name;
    text.textContent = label;
    g.appendChild(text);

    layer.appendChild(g);
  }

  // ---------- Simulation ----------
  function resetSimulation() {
    currentState = model && model.initial ? model.initial : null;
    els.simLog.innerHTML = '';
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
    logEntry(from + ' \u2014' + (t.event ? t.event : '\u03b5') + '\u2192 ' + t.to, false);
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
      logEntry('No transition for event "' + eventName + '" from state "' + currentState + '"', true);
    }
  }

  function logEntry(text, isError) {
    var li = document.createElement('li');
    li.textContent = text;
    if (isError) li.className = 'log-error';
    els.simLog.appendChild(li);
    els.simLog.scrollTop = els.simLog.scrollHeight;
  }

  // ---------- Wiring ----------
  function rebuildFromText(text) {
    model = parseDefinition(text);
    renderErrors(model.errors);
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
    } catch (e) {
      saved = null;
    }
    var initialText = (saved !== null) ? saved : EXAMPLES.traffic;
    els.input.value = initialText;
    rebuildFromText(initialText);
  }

  init();
})();
