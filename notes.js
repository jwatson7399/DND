/* Journal notes: shared corrections and additions stored in Supabase.
   Loaded by index.html with the project URL and anon key as data attributes:
     <script src="notes.js" data-supabase-url="..." data-supabase-key="..."></script>
   The journal HTML can be replaced wholesale. This file finds sections and
   cards at runtime and injects a notes area into each one:
     - every major section (h2 with a known id) and every session block gets a
       notes list plus an "Add note" button at its bottom
     - every card inside those sections (characters, quests, NPCs, places,
       enemies) gets a compact "Add note" control of its own
     - every numbered kill inside the kill recaps gets one too
     - a General box closes the page
   Card notes use a section id of "<parent>--<slug of card name>". If a card is
   renamed or removed later, its notes fall back to the parent section list. */
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
  var mounted = {};
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

  function slugify(text) {
    return String(text || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '');
  }

  function cardName(card) {
    var name = card.querySelector('.name');
    if (!name) return '';
    var clone = name.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('.pill, .tag'), function (n) { n.remove(); });
    return clone.textContent.trim();
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

  /* Notes belonging to a box. A section box also adopts notes from any card
     id under it ("party--jotham") that no longer has a box of its own. */
  function notesFor(box) {
    var id = box.section.id;
    var prefix = id + '--';
    var list = [];
    Object.keys(notesById).forEach(function (key) {
      var n = notesById[key];
      if (n.section === id) { list.push(n); return; }
      if (!box.section.card && n.section.indexOf(prefix) === 0 && !mounted[n.section]) list.push(n);
    });
    list.sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });
    return list;
  }

  /* ---------- section discovery ---------- */

  function cardsBetween(h2, stop) {
    var cards = [];
    var node = h2.nextElementSibling;
    while (node && node !== stop) {
      if (node.classList && node.classList.contains('card')) cards.push(node);
      else if (node.querySelectorAll) Array.prototype.push.apply(cards, node.querySelectorAll('.card'));
      node = node.nextElementSibling;
    }
    return cards;
  }

  function cardSections(parentId, cards) {
    var found = [];
    var seen = {};
    cards.forEach(function (card) {
      var name = cardName(card);
      var slug = slugify(name);
      if (!slug) return;
      var id = parentId + '--' + slug;
      if (seen[id]) return;
      seen[id] = true;
      found.push({
        id: id,
        label: name,
        session: null,
        card: true,
        mount: function (box) { card.appendChild(box); }
      });
    });
    return found;
  }

  function h2Sections() {
    var found = [];
    STATIC_SECTIONS.forEach(function (id) {
      var h2 = document.getElementById(id);
      if (!h2 || h2.tagName !== 'H2') return;
      var next = h2.nextElementSibling;
      while (next && next.tagName !== 'H2') next = next.nextElementSibling;
      found = found.concat(cardSections(id, cardsBetween(h2, next)));
      found.push({
        id: id,
        label: h2.textContent.trim(),
        session: null,
        card: false,
        mount: function (box) { h2.parentNode.insertBefore(box, next); }
      });
    });
    return found;
  }

  /* Kill recaps: details.kill blocks with ids like "kills-jotham". Each
     numbered kill gets its own control (enemies--kills-jotham-1). A character
     with no kills yet gets one control on the closest-call paragraph. */
  function killSections() {
    var found = [];
    var parent = document.getElementById('enemies') ? 'enemies' : null;
    if (!parent) return found;
    var blocks = document.querySelectorAll('details.kill[id^="kills-"]');
    Array.prototype.forEach.call(blocks, function (details) {
      var who = slugify(details.id.replace('kills-', ''));
      if (!who) return;
      var name = details.querySelector('summary');
      name = name ? name.childNodes[0].textContent.trim() : who;
      var kills = details.querySelectorAll('ol > li');
      if (kills.length) {
        Array.prototype.forEach.call(kills, function (li, i) {
          var title = li.querySelector('b');
          found.push({
            id: parent + '--kills-' + who + '-' + (i + 1),
            label: name + ', kill ' + (i + 1) + (title ? ': ' + title.textContent.trim() : ''),
            session: null,
            card: true,
            mount: function (box) { li.appendChild(box); }
          });
        });
      } else {
        var body = details.querySelector('.body') || details;
        found.push({
          id: parent + '--kills-' + who,
          label: name + ', no kills yet',
          session: null,
          card: true,
          mount: function (box) { body.appendChild(box); }
        });
      }
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
        card: false,
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
      card: false,
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
    var root = el('section', 'notes-box' + (section.card ? ' compact' : ''));
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

    var add = el('button', 'notes-add', '+ Add note');
    add.type = 'button';
    add.title = section.card ? 'Add a note about ' + section.label : 'Add a note to ' + section.label;

    var form = el('form', 'notes-form');
    form.hidden = true;
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
    textarea.placeholder = section.card
      ? 'Correction or addition about ' + section.label
      : 'Correction, missed detail, or something the audio did not catch';
    textarea.maxLength = 2000;
    textarea.rows = 3;

    var actions = el('div', 'actions');
    var button = el('button', null, 'Add note');
    button.type = 'submit';
    var cancel = el('button', 'notes-cancel', 'Cancel');
    cancel.type = 'button';
    var error = el('div', 'notes-error', '');
    actions.appendChild(button);
    actions.appendChild(cancel);
    actions.appendChild(error);

    form.appendChild(row);
    form.appendChild(textarea);
    form.appendChild(actions);

    root.appendChild(head);
    root.appendChild(status);
    root.appendChild(list);
    root.appendChild(add);
    root.appendChild(form);

    var box = {
      section: section,
      root: root,
      count: count,
      toggle: toggle,
      list: list,
      status: status,
      add: add,
      form: form,
      select: select,
      textarea: textarea,
      button: button,
      error: error,
      showResolved: false,
      composing: false
    };

    add.addEventListener('click', function () { openForm(box); });
    cancel.addEventListener('click', function () { closeForm(box); });
    select.addEventListener('change', function () { saveAuthor(select.value); error.textContent = ''; });
    toggle.addEventListener('click', function () { box.showResolved = !box.showResolved; renderBox(box); });
    form.addEventListener('submit', function (evt) { evt.preventDefault(); submit(box); });

    section.mount(root);
    mounted[section.id] = true;
    return box;
  }

  function openForm(box) {
    box.composing = true;
    box.form.hidden = false;
    box.add.hidden = true;
    box.error.textContent = '';
    if (box.select.value) box.textarea.focus(); else box.select.focus();
  }

  function closeForm(box) {
    box.composing = false;
    box.form.hidden = true;
    box.add.hidden = !(available && client);
    box.error.textContent = '';
  }

  function renderBox(box) {
    var all = notesFor(box);
    var resolved = all.filter(function (n) { return n.resolved; });
    var open = all.length - resolved.length;

    box.count.textContent = open ? '(' + open + ')' : '';
    box.list.textContent = '';
    all.forEach(function (note) {
      if (note.resolved && !box.showResolved) return;
      var li = el('li', note.resolved ? 'resolved' : '');
      var meta = el('div', 'note-meta');
      meta.appendChild(el('span', 'note-author', note.author));
      var time = el('span', 'note-time', ' ' + relativeTime(note.created_at));
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

    var canPost = !!(available && client);
    if (!available) {
      box.status.hidden = false;
      box.status.textContent = loadedOnce ? 'Notes unavailable. Showing the last copy that loaded.' : 'Notes unavailable.';
      if (!loadedOnce) box.list.textContent = '';
    } else if (!all.length && !box.section.card) {
      box.status.hidden = false;
      box.status.textContent = 'No notes yet.';
    } else {
      box.status.hidden = true;
    }

    /* Compact card boxes hide their header until something is there to show. */
    box.root.classList.toggle('empty', box.section.card && !all.length);

    box.add.hidden = box.composing || !canPost;
    if (!canPost && box.composing) closeForm(box);
    box.select.disabled = !canPost;
    box.textarea.disabled = !canPost;
    if (!box.inFlight) box.button.disabled = !canPost;
  }

  function renderAll() {
    boxes.forEach(renderBox);
    renderBadges();
  }

  /* Table of contents badges: unresolved notes per top-level section,
     including notes on the cards inside it. */
  function renderBadges() {
    var counts = {};
    Object.keys(notesById).forEach(function (id) {
      var n = notesById[id];
      if (n.resolved) return;
      var top = n.section.split('--')[0];
      counts[top] = (counts[top] || 0) + 1;
    });
    boxes.forEach(function (box) {
      if (box.section.card) return;
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
        closeForm(box);
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
    var sections = h2Sections().concat(killSections(), sessionSections());
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
