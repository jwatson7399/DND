/* Journal notes: shared corrections and additions stored in Supabase.
   Loaded by index.html with the project URL and anon key as data attributes:
     <script src="notes.js" data-supabase-url="..." data-supabase-key="..."></script>
   The journal HTML can be replaced wholesale. This file finds sections by id
   at runtime and injects a notes box at the bottom of each one. */
(function () {
  'use strict';

  var script = document.currentScript;
  var SUPABASE_URL = script ? script.getAttribute('data-supabase-url') : '';
  var SUPABASE_KEY = script ? script.getAttribute('data-supabase-key') : '';
  var TABLE = 'journal_notes';
  var AUTHORS = ['Jotham', 'Soren', 'Aurelian', 'Erlathon', 'Durian', 'DM'];
  var STATIC_SECTIONS = ['overview', 'story-so-far', 'party', 'quests', 'npcs',
    'locations', 'enemies', 'state', 'lessons', 'table'];
  var AUTHOR_KEY = 'journal_notes_author';
  var POLL_MS = 60000;
  var REQUEST_TIMEOUT_MS = 12000;

  var client = null;
  var notesById = {};
  var boxes = [];
  var available = false;
  var loadedOnce = false;
  var author = readAuthor();

  /* ---------- helpers ---------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function readAuthor() {
    try {
      var saved = localStorage.getItem(AUTHOR_KEY);
      return AUTHORS.indexOf(saved) >= 0 ? saved : '';
    } catch (e) { return ''; }
  }

  function saveAuthor(value) {
    author = value;
    try { localStorage.setItem(AUTHOR_KEY, value); } catch (e) { /* private mode */ }
    boxes.forEach(function (box) { if (box.select.value !== value) box.select.value = value; });
  }

  function relativeTime(iso) {
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '';
    var diff = Math.max(0, Date.now() - then);
    var m = Math.round(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
    var h = Math.round(m / 60);
    if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
    var d = Math.round(h / 24);
    if (d === 1) return 'yesterday';
    if (d < 30) return d + ' days ago';
    var mo = Math.round(d / 30);
    if (mo < 12) return mo + (mo === 1 ? ' month ago' : ' months ago');
    var y = Math.round(d / 365);
    return y + (y === 1 ? ' year ago' : ' years ago');
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('timeout')); }, ms);
      Promise.resolve(promise).then(function (v) { clearTimeout(timer); resolve(v); },
        function (e) { clearTimeout(timer); reject(e); });
    });
  }

  function friendlyError(err) {
    var msg = (err && (err.message || err.details || err.hint)) || '';
    if (/rate limit|too many notes/i.test(msg)) return 'Slow down: more than 20 notes in 10 minutes from one author.';
    if (/author/i.test(msg) && /check|violat/i.test(msg)) return 'Pick a valid name from the list.';
    if (/body/i.test(msg) && /check|violat/i.test(msg)) return 'Notes must be 1 to 2000 characters.';
    if (/timeout|fetch|network/i.test(msg)) return 'Could not reach the notes server. Check your connection and try again.';
    return 'Could not save the note. ' + (msg ? msg : 'Try again.');
  }

  function notesFor(section) {
    var list = [];
    Object.keys(notesById).forEach(function (id) {
      if (notesById[id].section === section) list.push(notesById[id]);
    });
    list.sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });
    return list;
  }

  /* ---------- section discovery ---------- */

  function h2Sections() {
    var found = [];
    STATIC_SECTIONS.forEach(function (id) {
      var h2 = document.getElementById(id);
      if (!h2 || h2.tagName !== 'H2') return;
      var next = h2.nextElementSibling;
      while (next && next.tagName !== 'H2') next = next.nextElementSibling;
      found.push({
        id: id,
        label: h2.textContent.trim(),
        session: null,
        mount: function (box) { h2.parentNode.insertBefore(box, next); }
      });
    });
    return found;
  }

  function sessionSections() {
    var found = [];
    var nodes = document.querySelectorAll('details.session[id^="session-"]');
    Array.prototype.forEach.call(nodes, function (details) {
      var body = details.querySelector('.body') || details;
      var n = parseInt(details.id.replace('session-', ''), 10);
      found.push({
        id: details.id,
        label: 'Session ' + (isNaN(n) ? '' : n),
        session: isNaN(n) ? null : n,
        mount: function (box) { body.appendChild(box); }
      });
    });
    return found;
  }

  function generalSection() {
    var main = document.querySelector('main') || document.body;
    return {
      id: 'general',
      label: 'General notes',
      session: null,
      mount: function (box) {
        var wrap = el('div', 'notes-general');
        var h2 = el('h2', null, 'General notes');
        h2.id = 'general-notes';
        var p = el('p', 'uncertain', 'Anything that does not fit a section above: rules questions, ideas, things to ask the DM.');
        wrap.appendChild(h2);
        wrap.appendChild(p);
        wrap.appendChild(box);
        main.appendChild(wrap);
      }
    };
  }

  /* ---------- box construction ---------- */

  function buildBox(section) {
    var root = el('section', 'notes-box');
    root.setAttribute('data-section', section.id);

    var head = el('div', 'notes-head');
    var title = el('span', 'notes-title', 'Notes ');
    var count = el('b', null, '');
    title.appendChild(count);
    var toggle = el('button', 'notes-toggle', '');
    toggle.type = 'button';
    toggle.hidden = true;
    head.appendChild(title);
    head.appendChild(toggle);

    var list = el('ul', 'notes-list');
    var status = el('p', 'notes-status', 'Loading notes...');

    var form = el('form', 'notes-form');
    var row = el('div', 'row');
    var label = el('label', null, 'Posting as ');
    var select = el('select');
    var placeholder = el('option', null, 'Choose your name');
    placeholder.value = '';
    placeholder.disabled = true;
    select.appendChild(placeholder);
    AUTHORS.forEach(function (name) {
      var opt = el('option', null, name);
      opt.value = name;
      select.appendChild(opt);
    });
    select.value = author;
    label.appendChild(select);
    row.appendChild(label);

    var textarea = el('textarea');
    textarea.placeholder = 'Correction, missed detail, or something the audio did not catch';
    textarea.maxLength = 2000;
    textarea.rows = 3;

    var actions = el('div', 'actions');
    var button = el('button', null, 'Add note');
    button.type = 'submit';
    var error = el('div', 'notes-error', '');
    actions.appendChild(button);
    actions.appendChild(error);

    form.appendChild(row);
    form.appendChild(textarea);
    form.appendChild(actions);

    root.appendChild(head);
    root.appendChild(status);
    root.appendChild(list);
    root.appendChild(form);

    var box = {
      section: section,
      root: root,
      count: count,
      toggle: toggle,
      list: list,
      status: status,
      form: form,
      select: select,
      textarea: textarea,
      button: button,
      error: error,
      showResolved: false
    };

    select.addEventListener('change', function () { saveAuthor(select.value); error.textContent = ''; });
    toggle.addEventListener('click', function () { box.showResolved = !box.showResolved; renderBox(box); });
    form.addEventListener('submit', function (evt) { evt.preventDefault(); submit(box); });

    section.mount(root);
    return box;
  }

  function renderBox(box) {
    var all = notesFor(box.section.id);
    var resolved = all.filter(function (n) { return n.resolved; });
    var open = all.length - resolved.length;

    box.count.textContent = open ? '(' + open + ')' : '';
    box.list.textContent = '';
    all.forEach(function (note) {
      if (note.resolved && !box.showResolved) return;
      var li = el('li', note.resolved ? 'resolved' : (note.pending ? 'pending' : ''));
      var meta = el('div', 'note-meta');
      meta.appendChild(el('span', 'note-author', note.author));
      var time = el('span', 'note-time', ' ' + (note.pending ? 'saving...' : relativeTime(note.created_at)));
      time.title = note.created_at ? new Date(note.created_at).toLocaleString() : '';
      meta.appendChild(time);
      li.appendChild(meta);
      li.appendChild(el('div', 'note-body', note.body));
      box.list.appendChild(li);
    });

    if (resolved.length) {
      box.toggle.hidden = false;
      box.toggle.textContent = (box.showResolved ? 'hide resolved (' : 'show resolved (') + resolved.length + ')';
    } else {
      box.toggle.hidden = true;
    }

    if (!available) {
      box.status.hidden = false;
      box.status.textContent = loadedOnce ? 'Notes unavailable. Showing the last copy that loaded.' : 'Notes unavailable.';
      if (!loadedOnce) box.list.textContent = '';
    } else if (!all.length) {
      box.status.hidden = false;
      box.status.textContent = 'No notes yet.';
    } else {
      box.status.hidden = true;
    }

    var canPost = available && client;
    box.form.classList.toggle('disabled', !canPost);
    box.select.disabled = !canPost;
    box.textarea.disabled = !canPost;
    if (!box.inFlight) box.button.disabled = !canPost;
  }

  function renderAll() {
    boxes.forEach(renderBox);
    renderBadges();
  }

  function renderBadges() {
    var counts = {};
    Object.keys(notesById).forEach(function (id) {
      var n = notesById[id];
      if (!n.resolved) counts[n.section] = (counts[n.section] || 0) + 1;
    });
    boxes.forEach(function (box) {
      var link = document.querySelector('nav.toc a[href="#' + box.section.id + '"]');
      if (!link) return;
      var badge = link.querySelector('.notes-badge');
      var n = counts[box.section.id] || 0;
      if (!n) { if (badge) badge.remove(); return; }
      if (!badge) { badge = el('span', 'notes-badge'); link.appendChild(badge); }
      badge.textContent = String(n);
      badge.title = n + (n === 1 ? ' unresolved note' : ' unresolved notes');
    });
  }

  /* ---------- data ---------- */

  function submit(box) {
    box.error.textContent = '';
    var name = box.select.value;
    var body = box.textarea.value.trim();
    if (!name) { box.error.textContent = 'Choose who you are posting as first.'; box.select.focus(); return; }
    if (!body) { box.error.textContent = 'Write something first.'; box.textarea.focus(); return; }
    if (body.length > 2000) { box.error.textContent = 'Notes must be 2000 characters or fewer.'; return; }
    if (!client || !available) { box.error.textContent = 'Notes unavailable right now.'; return; }

    box.inFlight = true;
    box.button.disabled = true;
    var payload = { section: box.section.id, author: name, body: body, session: box.section.session };

    withTimeout(client.from(TABLE).insert(payload).select().single(), REQUEST_TIMEOUT_MS)
      .then(function (res) {
        if (res.error) throw res.error;
        notesById[res.data.id] = res.data;
        box.textarea.value = '';
        renderAll();
      })
      .catch(function (err) {
        box.error.textContent = friendlyError(err);
      })
      .then(function () {
        box.inFlight = false;
        box.button.disabled = !(available && client);
      });
  }

  function fetchAll() {
    if (!client) return Promise.reject(new Error('no client'));
    return withTimeout(client.from(TABLE).select('*').order('created_at', { ascending: true }), REQUEST_TIMEOUT_MS)
      .then(function (res) {
        if (res.error) throw res.error;
        var fresh = {};
        (res.data || []).forEach(function (n) { fresh[n.id] = n; });
        notesById = fresh;
        available = true;
        loadedOnce = true;
        renderAll();
      })
      .catch(function () {
        available = false;
        renderAll();
      });
  }

  function startRealtime() {
    if (!client || typeof client.channel !== 'function') return;
    try {
      client.channel('journal-notes-feed')
        .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, function (payload) {
          if (payload.eventType === 'DELETE') {
            if (payload.old && payload.old.id) delete notesById[payload.old.id];
          } else if (payload.new && payload.new.id) {
            notesById[payload.new.id] = payload.new;
          }
          renderAll();
        })
        .subscribe();
    } catch (e) { /* polling still covers it */ }
  }

  function startPolling() {
    setInterval(function () {
      if (document.hidden) return;
      fetchAll();
    }, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) fetchAll();
    });
  }

  /* ---------- boot ---------- */

  function boot() {
    var sections = h2Sections().concat(sessionSections());
    sections.push(generalSection());
    boxes = sections.map(buildBox);

    if (!SUPABASE_URL || !SUPABASE_KEY || !window.supabase || typeof window.supabase.createClient !== 'function') {
      available = false;
      renderAll();
      return;
    }
    try {
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    } catch (e) {
      client = null;
      available = false;
      renderAll();
      return;
    }
    fetchAll().then(function () {
      startRealtime();
      startPolling();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
