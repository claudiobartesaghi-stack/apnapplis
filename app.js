/*
 * ApnAppLis — versione web (per iPhone e qualsiasi browser).
 * Liste spuntabili con catalogo "Tipo → Categorie → Voci", come l'app Android.
 * I dati restano nel browser (localStorage). Liste e cataloghi si inviano con un
 * link che contiene i dati nel frammento (#d=...), nello stesso formato dell'app
 * Android (vedi ShareCodec.kt): JSON compresso deflate-raw in base64url.
 */
'use strict';

const STORE_KEY = 'apnapplis.v1';
const HINT_KEY = 'apnapplis.hint-home';
const ANDROID_PACKAGE = 'com.apnapplis.web';
const PALETTE = ['#34D3B3', '#7C8CFF', '#FFB25C', '#FF7BA9', '#B6E06A'];

// ---------------------------------------------------------------- Dati
/*
 * db = {
 *   nextId,
 *   types: [{ id, name, categories: [{ id, name, items: [{ id, name }] }] }],
 *   lists: [{ id, name, createdAt, typeId, items: [{ id, text, done, categoryId }] }]
 * }
 * L'ordine degli array è l'ordine mostrato.
 */
let db = loadDb();

function emptyDb() { return { nextId: 1, types: [], lists: [] }; }

function loadDb() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.types) && Array.isArray(d.lists)) return d;
    }
  } catch (e) { /* storage non disponibile: si parte vuoti */ }
  return emptyDb();
}

function saveDb() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
  catch (e) { toast('Impossibile salvare: la memoria del browser non è disponibile'); }
}

function commit() { saveDb(); render(); }
function newId() { return db.nextId++; }

const typeById = id => db.types.find(t => t.id === id);
const listById = id => db.lists.find(l => l.id === id);
const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const accent = id => PALETTE[Math.abs(id || 0) % PALETTE.length];
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many) => n === 1 ? `1 ${one}` : `${n} ${many}`;

/** Elementi raggruppati: categorie nell'ordine del catalogo, poi "Altro". */
function groupItems(list) {
  const type = typeById(list.typeId);
  const cats = type ? type.categories : [];
  const known = new Set(cats.map(c => c.id));
  const groups = [];
  for (const c of cats) {
    const items = list.items.filter(i => i.categoryId === c.id);
    if (items.length) groups.push({ category: c, items });
  }
  const other = list.items.filter(i => i.categoryId == null || !known.has(i.categoryId));
  if (other.length) groups.push({ category: null, items: other });
  return groups;
}

function ensureType(name) {
  let t = db.types.find(x => same(x.name, name));
  if (!t) { t = { id: newId(), name: name.trim(), categories: [] }; db.types.push(t); }
  return t;
}
function ensureCategory(type, name) {
  let c = type.categories.find(x => same(x.name, name));
  if (!c) { c = { id: newId(), name: name.trim(), items: [] }; type.categories.push(c); }
  return c;
}
function ensureItem(category, name) {
  let i = category.items.find(x => same(x.name, name));
  if (!i) { i = { id: newId(), name: name.trim() }; category.items.push(i); }
  return i;
}

function moveInArray(arr, index, delta) {
  const to = index + delta;
  if (index < 0 || to < 0 || to >= arr.length) return;
  arr.splice(to, 0, arr.splice(index, 1)[0]);
}

// ---------------------------------------------------------------- Link condivisi
function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function pipeBytes(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const canCompress = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function encodePayload(obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  return b64urlEncode(await pipeBytes(json, new CompressionStream('deflate-raw')));
}

async function decodePayload(data) {
  const bytes = await pipeBytes(b64urlDecode(data), new DecompressionStream('deflate-raw'));
  return normalizePayload(JSON.parse(new TextDecoder().decode(bytes)));
}

/** Controlla e uniforma il contenuto ricevuto (stesse regole dell'app Android). */
function normalizePayload(j) {
  if (!j || !Array.isArray(j.g)) throw new Error('formato');
  const str = v => (typeof v === 'string' ? v.trim() : '');
  const groups = j.g.map(g => ({
    category: str(g.c) || null,
    entries: (Array.isArray(g.i) ? g.i : []).map(e => Array.isArray(e)
      ? { text: str(e[0]), done: e[1] === 1 }
      : { text: str(e), done: false }).filter(e => e.text)
  }));
  const typeName = str(j.t) || null;
  if (j.k === 'l') return { kind: 'l', name: str(j.n) || 'Lista', typeName, groups };
  if (j.k === 'c' && typeName) return { kind: 'c', typeName, groups: groups.filter(g => g.category) };
  throw new Error('tipo');
}

function findData(text) {
  const m = /[#?&]d=([A-Za-z0-9_-]+)/.exec(text || '');
  return m ? m[1] : null;
}

function baseUrl() { return location.origin + location.pathname; }

function exportList(list) {
  const type = typeById(list.typeId);
  return {
    kind: 'l', name: list.name, typeName: type ? type.name : null,
    groups: groupItems(list).map(g => ({
      category: g.category ? g.category.name : null,
      entries: g.items.map(i => ({ text: i.text, done: i.done }))
    }))
  };
}

function exportCatalog(type) {
  return {
    kind: 'c', typeName: type.name,
    groups: type.categories.map(c => ({ category: c.name, entries: c.items.map(i => ({ text: i.name, done: false })) }))
  };
}

function toWire(p) {
  if (p.kind === 'l') {
    const o = { v: 1, k: 'l', n: p.name };
    if (p.typeName) o.t = p.typeName;
    o.g = p.groups.map(g => ({ c: g.category, i: g.entries.map(e => [e.text, e.done ? 1 : 0]) }));
    return o;
  }
  return { v: 1, k: 'c', t: p.typeName, g: p.groups.map(g => ({ c: g.category, i: g.entries.map(e => e.text) })) };
}

/** Testo leggibile da chiunque, seguito dal link per importare. */
async function shareTextFor(p) {
  const link = baseUrl() + '#d=' + await encodePayload(toWire(p));
  let s = '';
  if (p.kind === 'l') {
    s += `📝 ${p.name}\n`;
    const headers = p.groups.some(g => g.category);
    for (const g of p.groups) {
      s += '\n';
      if (headers) s += `${g.category || 'Altro'}\n`;
      for (const e of g.entries) s += `${e.done ? '☑' : '☐'} ${e.text}\n`;
    }
    s += '\nApri o importa la lista in ApnAppLis:\n';
  } else {
    s += `📚 Catalogo «${p.typeName}»\n\n`;
    for (const g of p.groups) s += `${g.category}: ${g.entries.map(e => e.text).join(', ')}\n`;
    s += '\nImporta il catalogo in ApnAppLis:\n';
  }
  return s + link;
}

async function share(p, title) {
  if (!canCompress) { toast('Questo browser è troppo vecchio per creare il link: aggiornalo'); return; }
  const text = await shareTextFor(p);
  if (navigator.share) {
    try { await navigator.share({ title, text }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(text); toast('Copiato: incollalo in WhatsApp, SMS o email'); }
  catch (e) { await infoDialog('Copia questo testo', `<textarea class="field block" rows="8" readonly>${esc(text)}</textarea>`); }
}

function importPayload(p) {
  if (p.kind === 'l') {
    const type = p.typeName ? ensureType(p.typeName) : null;
    const list = { id: newId(), name: p.name, createdAt: Date.now(), typeId: type ? type.id : null, items: [] };
    for (const g of p.groups) {
      const cat = type && g.category ? ensureCategory(type, g.category) : null;
      for (const e of g.entries) {
        if (cat) ensureItem(cat, e.text);
        list.items.push({ id: newId(), text: e.text, done: e.done, categoryId: cat ? cat.id : null });
      }
    }
    db.lists.push(list);
    saveDb();
    navigate({ name: 'list', id: list.id });
  } else {
    const type = ensureType(p.typeName);
    for (const g of p.groups) {
      const cat = ensureCategory(type, g.category);
      for (const e of g.entries) ensureItem(cat, e.text);
    }
    saveDb();
    navigate({ name: 'catalog', typeId: type.id });
  }
  toast('Importato');
}

/** Mostra la richiesta di importazione per un link ricevuto. */
async function handleIncoming(text) {
  const data = findData(text);
  if (!data) return false;
  let p;
  try {
    if (!canCompress) throw new Error('browser');
    p = await decodePayload(data);
  } catch (e) {
    await infoDialog('Link non valido',
      e.message === 'browser'
        ? '<p>Questo browser è troppo vecchio per leggere il link: aggiornalo e riprova.</p>'
        : '<p>Il link non contiene una lista di ApnAppLis, oppure è incompleto.</p>');
    return true;
  }
  const entries = p.groups.reduce((n, g) => n + g.entries.length, 0);
  const cats = p.groups.filter(g => g.category).length;
  let summary = plural(entries, 'voce', 'voci');
  if (cats) summary += ' in ' + plural(cats, 'categoria', 'categorie');
  if (p.kind === 'l' && p.typeName) summary += ` · tipo «${esc(p.typeName)}»`;
  const isAndroid = /Android/i.test(navigator.userAgent);
  const appHref = `intent://import?d=${data}#Intent;scheme=apnapplis;package=${ANDROID_PACKAGE};end`;
  const choice = await dialog({
    title: p.kind === 'l' ? `Importare la lista «${esc(p.name)}»?` : `Importare il catalogo «${esc(p.typeName)}»?`,
    body: `<p>${summary}</p><p class="small">${p.kind === 'l'
      ? 'Verrà creata una nuova lista. Tipo e categorie che mancano verranno aggiunti al tuo catalogo.'
      : 'Le categorie e le voci verranno unite al tuo catalogo; quelle che hai già non vengono duplicate.'}</p>`
      + (isAndroid ? `<p class="small">Hai l'app Android? <a href="${appHref}" style="color:var(--teal)">Apri nell'app ApnAppLis 2</a></p>` : ''),
    buttons: [{ label: 'Annulla', value: false }, { label: 'Importa', value: true }]
  });
  if (choice) importPayload(p);
  return true;
}

// ---------------------------------------------------------------- Navigazione
let view = { name: 'lists' };

function navigate(v) {
  view = v;
  ui.menu = null;
  history.pushState({ view: v }, '', baseUrl());
  render();
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', e => {
  view = (e.state && e.state.view) || { name: 'lists' };
  ui.menu = null;
  closeSheet();
  render();
});

// Stato dell'interfaccia che non va salvato
const ui = {
  menu: null,          // chiave del menu aperto
  newText: '',         // testo in "Aggiungi elemento"
  collapsed: new Set(),// categorie chiuse nel catalogo
  picker: null         // { selected:Set, collapsed:Set, newItemFor, newItemText }
};

// ---------------------------------------------------------------- Icone
const ICONS = {
  back: '<path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>',
  more: '<path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
  add: '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>',
  edit: '<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>',
  del: '<path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>',
  check: '<path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>',
  close: '<path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

function menuHtml(key, items, label = 'Altre opzioni') {
  const open = ui.menu === key;
  return `<div class="menu-wrap">
    <button class="icon-btn small" data-act="menu" data-key="${esc(key)}" aria-label="${esc(label)}">${icon('more')}</button>
    ${open ? `<div class="menu-pop">${items.map(i =>
      `<button data-act="${i.act}" ${i.args || ''} class="${i.danger ? 'danger' : ''}" ${i.disabled ? 'disabled' : ''}>${esc(i.label)}</button>`
    ).join('')}</div>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- Schermate
function render() {
  // Mantiene focus e cursore del campo attivo dopo il ridisegno
  const active = document.activeElement;
  const focusId = active && active.id;
  const caret = focusId && active.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;

  const app = document.getElementById('app');
  if (view.name === 'list' && listById(view.id)) app.innerHTML = renderList(listById(view.id));
  else if (view.name === 'catalog') app.innerHTML = renderCatalog();
  else { view = { name: 'lists' }; app.innerHTML = renderLists(); }
  renderSheet();

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) { el.focus(); if (caret && el.setSelectionRange) el.setSelectionRange(caret[0], caret[1]); }
  }
}

function ring(progress, color) {
  const r = 20, c = 2 * Math.PI * r;
  return `<div class="ring" style="color:${color}">
    <svg viewBox="0 0 46 46"><circle cx="23" cy="23" r="${r}" fill="none" stroke="${color}" stroke-opacity=".18" stroke-width="4"/>
    <circle cx="23" cy="23" r="${r}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - progress)}"/></svg>
    <span>${Math.round(progress * 100)}%</span></div>`;
}

function renderLists() {
  const lists = [...db.lists].sort((a, b) => b.createdAt - a.createdAt);
  const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent) && !navigator.standalone;
  let hint = '';
  try { if (isIos && !localStorage.getItem(HINT_KEY)) hint = 'show'; } catch (e) { /* niente avviso */ }

  let html = `<div class="header">
      <div class="titles"><h1>Liste</h1>
        <div class="sub">${lists.length ? plural(lists.length, 'lista attiva', 'liste attive') : 'Spesa, valigia, cose da fare…'}</div></div>
      <button class="text-btn" data-act="nav-catalog">Catalogo</button>
      ${menuHtml('home', [{ act: 'import-paste', label: 'Importa da link…' }])}
    </div>`;
  if (hint) {
    html += `<div class="banner"><div class="t">Per usarla come un'app: tocca <b>Condividi</b> in Safari e poi
      <b>«Aggiungi alla schermata Home»</b>.</div><button class="icon-btn small" data-act="hide-hint" aria-label="Chiudi">${icon('close')}</button></div>`;
  }
  html += '<div class="content">';
  if (!lists.length) {
    html += `<div class="empty"><div class="blob"></div><h2>Nessuna lista</h2><p>Tocca + per crearne una</p></div>`;
  }
  for (const l of lists) {
    const total = l.items.length, done = l.items.filter(i => i.done).length;
    const color = accent(l.id), type = typeById(l.typeId);
    html += `<button class="card" data-act="open-list" data-id="${l.id}">
      ${ring(total ? done / total : 0, color)}
      <div class="main"><div class="name">${esc(l.name)}</div>
        <div class="chips"><span class="chip" style="--c:${color}">${total ? `${done} di ${total} completati` : 'Vuota'}</span>
        ${type ? `<span class="chip" style="--c:var(--outline)">${esc(type.name)}</span>` : ''}</div></div>
    </button>`;
  }
  html += `</div><button class="fab" data-act="new-list" aria-label="Nuova lista">${icon('add')}</button>`;
  return html;
}

function renderList(list) {
  const color = accent(list.id);
  const type = typeById(list.typeId);
  const done = list.items.filter(i => i.done).length;
  const sub = [type && esc(type.name), list.items.length ? `${done} di ${list.items.length} completati` : null]
    .filter(Boolean).join('  ·  ');
  const groups = groupItems(list);
  const headers = groups.some(g => g.category);

  let html = `<div class="topbar" style="--c:${color}">
      <button class="icon-btn" data-act="back" aria-label="Indietro">${icon('back')}</button>
      <div class="titles"><div class="title">${esc(list.name)}</div>${sub ? `<div class="sub" style="color:${color}">${sub}</div>` : ''}</div>
      ${menuHtml('list', [
        { act: 'share-list', label: 'Condividi lista' },
        { act: 'rename-list', label: 'Rinomina lista' },
        { act: 'change-type', label: 'Cambia tipo lista' },
        { act: 'nav-catalog', label: 'Gestisci catalogo', args: `data-type="${list.typeId || ''}"` },
        { act: 'sort-az', label: 'Ordina dalla A alla Z' },
        { act: 'done-bottom', label: 'Sposta i completati in fondo' },
        { act: 'clear-done', label: 'Rimuovi elementi completati' },
        { act: 'delete-list', label: 'Elimina lista', danger: true }
      ])}
    </div><div class="content with-bar" style="--c:${color}">`;

  if (!list.items.length) {
    html += `<div class="empty"><div class="blob"></div><h2>Lista vuota</h2>
      <p>Scrivi qui sotto, oppure tocca «Catalogo» per scegliere tra le voci memorizzate</p></div>`;
  }
  for (const g of groups) {
    if (headers) {
      const gd = g.items.filter(i => i.done).length;
      const c = g.category ? accent(g.category.id) : 'var(--outline)';
      html += `<div class="section"><span class="dot" style="--c:${c}"></span>${esc(g.category ? g.category.name : 'Altro')}  ·  ${gd}/${g.items.length}</div>`;
    }
    for (const it of g.items) {
      html += `<div class="row ${it.done ? 'done' : ''}">
        <button class="check ${it.done ? 'on' : ''}" data-act="toggle" data-id="${it.id}" aria-label="Spunta ${esc(it.text)}"><i></i></button>
        <div class="text" data-act="toggle" data-id="${it.id}">${esc(it.text)}</div>
        <button class="icon-btn small" data-act="edit-item" data-id="${it.id}" aria-label="Modifica">${icon('edit')}</button>
        <button class="icon-btn small" data-act="del-item" data-id="${it.id}" aria-label="Elimina">${icon('del')}</button>
      </div>`;
    }
  }
  html += `</div>
    <div class="bottombar" style="--c:${color}"><div class="inner">
      <button class="text-btn" style="color:${color}" data-act="open-picker">Catalogo</button>
      <input id="add-input" class="field" placeholder="Aggiungi elemento" enterkeyhint="done" autocomplete="off" value="${esc(ui.newText)}">
      <button class="icon-btn" style="color:${color}" data-act="add-item" aria-label="Aggiungi" ${ui.newText.trim() ? '' : 'disabled'}>${icon('add')}</button>
    </div></div>`;
  return html;
}

function currentCatalogType() {
  return typeById(view.typeId) || db.types[0] || null;
}

function renderCatalog() {
  const type = currentCatalogType();
  const tIndex = type ? db.types.indexOf(type) : -1;
  let html = `<div class="topbar">
      <button class="icon-btn" data-act="back" aria-label="Indietro">${icon('back')}</button>
      <div class="titles"><div class="title">Catalogo</div>
        <div class="sub" style="color:var(--on-surface-variant);font-weight:400">Voci memorizzate da aggiungere alle liste</div></div>
      ${type ? menuHtml('type', [
        { act: 'type-share', label: `Condividi «${type.name}»` },
        { act: 'type-rename', label: `Rinomina «${type.name}»` },
        { act: 'type-move', label: 'Sposta a sinistra', args: 'data-delta="-1"', disabled: tIndex <= 0 },
        { act: 'type-move', label: 'Sposta a destra', args: 'data-delta="1"', disabled: tIndex >= db.types.length - 1 },
        { act: 'type-delete', label: `Elimina «${type.name}»`, danger: true }
      ], 'Opzioni del tipo') : ''}
    </div>
    <div class="type-chips">
      ${db.types.map(t => `<button class="tchip ${type && t.id === type.id ? 'on' : ''}" style="--c:${accent(t.id)}" data-act="select-type" data-id="${t.id}">${esc(t.name)}</button>`).join('')}
      <button class="tchip" data-act="new-type">+ Nuovo tipo</button>
    </div><div class="content">`;

  if (!type) {
    html += `<div class="empty"><div class="blob"></div><h2>Nessun tipo di lista</h2>
      <p>Crea un tipo, ad esempio «Spesa», poi aggiungi le categorie (Frutta, Verdura…) e le loro voci</p></div>`;
  } else if (!type.categories.length) {
    html += `<div class="empty"><div class="blob"></div><h2>Nessuna categoria</h2>
      <p>Tocca + per aggiungere una categoria a «${esc(type.name)}»</p></div>`;
  } else {
    type.categories.forEach((c, ci) => {
      const closed = ui.collapsed.has(c.id);
      html += `<div class="cat"><div class="cat-head" data-act="cat-toggle" data-id="${c.id}">
          <span class="big-dot" style="--c:${accent(c.id)}"></span>
          <div class="main"><div class="name">${esc(c.name)}</div><div class="sub">${plural(c.items.length, 'voce', 'voci')}</div></div>
          <span class="chev">${closed ? '▼' : '▲'}</span>
          ${menuHtml('cat-' + c.id, [
            { act: 'cat-add-item', label: 'Aggiungi voce', args: `data-id="${c.id}"` },
            { act: 'cat-rename', label: 'Rinomina', args: `data-id="${c.id}"` },
            { act: 'cat-move', label: 'Sposta su', args: `data-id="${c.id}" data-delta="-1"`, disabled: ci === 0 },
            { act: 'cat-move', label: 'Sposta giù', args: `data-id="${c.id}" data-delta="1"`, disabled: ci === type.categories.length - 1 },
            { act: 'cat-delete', label: 'Elimina', args: `data-id="${c.id}"`, danger: true }
          ], 'Opzioni della categoria')}
        </div>`;
      if (!closed) {
        c.items.forEach((it, ii) => {
          html += `<div class="cat-item"><div class="name">${esc(it.name)}</div>
            ${menuHtml('item-' + it.id, [
              { act: 'item-rename', label: 'Rinomina', args: `data-cat="${c.id}" data-id="${it.id}"` },
              { act: 'item-move', label: 'Sposta su', args: `data-cat="${c.id}" data-id="${it.id}" data-delta="-1"`, disabled: ii === 0 },
              { act: 'item-move', label: 'Sposta giù', args: `data-cat="${c.id}" data-id="${it.id}" data-delta="1"`, disabled: ii === c.items.length - 1 },
              { act: 'item-delete', label: 'Elimina', args: `data-cat="${c.id}" data-id="${it.id}"`, danger: true }
            ], 'Opzioni della voce')}</div>`;
        });
        html += `<button class="text-btn add-line" data-act="cat-add-item" data-id="${c.id}">+ Aggiungi voce</button>`;
      }
      html += '</div>';
    });
  }
  html += `</div><button class="fab" data-act="${type ? 'new-category' : 'new-type'}" aria-label="${type ? 'Nuova categoria' : 'Nuovo tipo'}">${icon('add')}</button>`;
  return html;
}

// ---------------------------------------------------------------- Scelta dal catalogo
function openSheet() {
  ui.picker = { selected: new Set(), collapsed: new Set(), newItemFor: null, newItemText: '' };
  renderSheet();
}
function closeSheet() { ui.picker = null; renderSheet(); }

function renderSheet() {
  const box = document.getElementById('sheet');
  const list = view.name === 'list' ? listById(view.id) : null;
  const type = list && typeById(list.typeId);
  if (!ui.picker || !type) { box.innerHTML = ''; return; }
  const pk = ui.picker;
  const color = accent(list.id);
  const present = new Set(list.items.filter(i => !i.done).map(i => i.text.toLowerCase()));

  let body = '';
  if (!type.categories.length) body = `<p class="muted">Nessuna categoria per questo tipo.<br>Creane una con «Nuova categoria».</p>`;
  for (const c of type.categories) {
    const closed = pk.collapsed.has(c.id);
    const count = c.items.filter(i => pk.selected.has(i.id)).length;
    body += `<div class="pk-cat" data-act="pk-cat" data-id="${c.id}">
      <span class="dot" style="--c:${accent(c.id)};width:8px;height:8px"></span><span class="name">${esc(c.name)}</span>
      ${count ? `<span class="chip" style="--c:${color}">${count} scelte</span>` : ''}<span class="chev">${closed ? '▼' : '▲'}</span></div>`;
    if (closed) continue;
    for (const it of c.items) {
      const already = present.has(it.name.toLowerCase());
      const on = already || pk.selected.has(it.id);
      body += `<div class="pk-item ${already ? 'already' : ''}" ${already ? '' : `data-act="pk-toggle" data-id="${it.id}"`}>
        <button class="check ${on ? 'on' : ''}" style="--c:${color}" ${already ? 'disabled' : `data-act="pk-toggle" data-id="${it.id}"`} aria-label="Scegli ${esc(it.name)}"><i></i></button>
        <span class="name">${esc(it.name)}</span>${already ? '<small>già in lista</small>' : ''}</div>`;
    }
    if (pk.newItemFor === c.id) {
      body += `<div class="pk-new"><input id="pk-new-input" class="field" style="--c:${color}" data-cat="${c.id}"
          placeholder="Nuova voce in ${esc(c.name)}" enterkeyhint="done" autocomplete="off" value="${esc(pk.newItemText)}">
        <button class="icon-btn" style="color:${color}" data-act="pk-save-item" data-id="${c.id}" aria-label="Salva voce">${icon('check')}</button></div>`;
    } else {
      body += `<button class="text-btn" style="margin-left:8px" data-act="pk-new-item" data-id="${c.id}">+ Nuova voce</button>`;
    }
  }

  box.innerHTML = `<div class="backdrop" data-act="pk-close-bg"><div class="sheet" role="dialog" aria-label="Aggiungi dal catalogo">
    <div class="grab"></div>
    <div class="sheet-head"><div class="titles"><h2>Aggiungi dal catalogo</h2>
      <div class="sub" style="color:${color};font-weight:600">${esc(type.name)}</div></div>
      <button class="text-btn" data-act="pk-manage">Gestisci</button></div>
    <div class="sheet-body">${body}</div>
    <div class="sheet-foot"><button class="btn outlined" data-act="pk-new-cat">Nuova categoria</button>
      <button class="btn filled" style="--c:${color}" data-act="pk-confirm" ${pk.selected.size ? '' : 'disabled'}>
        ${pk.selected.size ? `Aggiungi (${pk.selected.size})` : 'Aggiungi'}</button></div>
  </div></div>`;
}

function pickerSaveItem(catId) {
  const list = listById(view.id), type = list && typeById(list.typeId);
  const cat = type && type.categories.find(c => c.id === catId);
  const text = ui.picker.newItemText.trim();
  if (!cat || !text) return;
  const present = list.items.some(i => !i.done && same(i.text, text));
  const item = ensureItem(cat, text);
  if (!present) ui.picker.selected.add(item.id);
  ui.picker.newItemText = '';
  commit();
}

// ---------------------------------------------------------------- Finestre di dialogo
/** Finestra generica; risolve con il valore del pulsante premuto (null se chiusa). */
function dialog({ title, body, buttons, onOpen, collect }) {
  return new Promise(resolve => {
    const box = document.getElementById('modal');
    box.innerHTML = `<div class="dialog-back"><div class="dialog" role="dialog" aria-modal="true">
      <h3>${title}</h3>${body || ''}
      <div class="actions">${buttons.map((b, i) =>
        `<button class="text-btn ${b.danger ? 'danger' : ''}" style="${b.danger ? 'color:var(--error)' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>
    </div></div>`;
    const back = box.firstElementChild;
    const finish = v => { box.innerHTML = ''; resolve(v); };
    const btns = buttons.map((b, i) => back.querySelector(`[data-i="${i}"]`));
    back.addEventListener('click', e => {
      if (e.target === back) return finish(null);
      const i = e.target.closest('[data-i]');
      if (!i) return;
      const b = buttons[+i.dataset.i];
      if (b.value === false || b.value == null) return finish(b.value ?? null);
      finish(collect ? collect(back) : b.value);
    });
    back.addEventListener('keydown', e => {
      if (e.key === 'Escape') finish(null);
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type === 'text') {
        const ok = btns[btns.length - 1];
        if (!ok.disabled) ok.click();
      }
    });
    if (onOpen) onOpen(back, btns[btns.length - 1]);
    const first = back.querySelector('input[type=text], textarea');
    if (first) setTimeout(() => first.focus(), 30);
  });
}

function infoDialog(title, body) {
  return dialog({ title: esc(title), body, buttons: [{ label: 'OK', value: true }] });
}

function confirmDialog(message, label = 'Elimina') {
  return dialog({ title: esc(message), buttons: [{ label: 'Annulla', value: false }, { label, value: true, danger: true }] });
}

function promptDialog(title, label, initial = '', confirm = 'Salva') {
  return dialog({
    title: esc(title),
    body: `<label class="lbl" for="dlg-text">${esc(label)}</label><input id="dlg-text" type="text" class="field" autocomplete="off" value="${esc(initial)}">`,
    buttons: [{ label: 'Annulla', value: false }, { label: confirm, value: true }],
    onOpen: (root, ok) => {
      const input = root.querySelector('#dlg-text');
      const sync = () => { ok.disabled = !input.value.trim(); };
      input.addEventListener('input', sync); sync();
    },
    collect: root => root.querySelector('#dlg-text').value.trim()
  });
}

/** Scelta del tipo di lista; con withName chiede anche il nome (nuova lista). */
function typeDialog({ title, withName, current, message }) {
  const radios = [{ v: '', label: 'Nessuno' }, ...db.types.map(t => ({ v: String(t.id), label: t.name })), { v: 'new', label: 'Nuovo tipo…' }];
  const cur = current ? String(current) : '';
  return dialog({
    title: esc(title),
    body: (message ? `<p>${esc(message)}</p>` : '')
      + (withName ? `<label class="lbl" for="dlg-name">Nome della lista</label><input id="dlg-name" type="text" class="field" autocomplete="off">` : '')
      + `<div class="group-title">Tipo di lista</div><p class="small">Il tipo decide da quale catalogo scegliere le voci.</p>`
      + radios.map(r => `<label class="radio"><input type="radio" name="dlg-type" value="${r.v}" ${r.v === cur ? 'checked' : ''}>${esc(r.label)}</label>`).join('')
      + `<input id="dlg-newtype" type="text" class="field block" placeholder="Nome del tipo (es. Spesa)" autocomplete="off" hidden>`,
    buttons: [{ label: 'Annulla', value: false }, { label: withName ? 'Crea' : 'Conferma', value: true }],
    onOpen: (root, ok) => {
      const name = root.querySelector('#dlg-name');
      const newType = root.querySelector('#dlg-newtype');
      const sync = () => {
        const sel = root.querySelector('input[name=dlg-type]:checked').value;
        newType.hidden = sel !== 'new';
        ok.disabled = (withName && !name.value.trim()) || (sel === 'new' && !newType.value.trim());
      };
      root.addEventListener('input', sync); root.addEventListener('change', sync); sync();
    },
    collect: root => {
      const sel = root.querySelector('input[name=dlg-type]:checked').value;
      return {
        name: withName ? root.querySelector('#dlg-name').value.trim() : null,
        typeId: sel && sel !== 'new' ? +sel : null,
        newTypeName: sel === 'new' ? root.querySelector('#dlg-newtype').value.trim() : null
      };
    }
  });
}

function resolveType(r) { return r.newTypeName ? ensureType(r.newTypeName).id : r.typeId; }

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------------------------------------------------------------- Azioni
function findListItem(id) {
  const list = listById(view.id);
  return list ? list.items.find(i => i.id === id) : null;
}

function addItem() {
  const list = listById(view.id);
  const text = ui.newText.trim();
  if (!list || !text) return;
  // Se il testo è una voce del catalogo, l'elemento va nella sua categoria
  const type = typeById(list.typeId);
  const cat = type && type.categories.find(c => c.items.some(i => same(i.name, text)));
  list.items.push({ id: newId(), text, done: false, categoryId: cat ? cat.id : null });
  ui.newText = '';
  commit();
}

async function openPicker() {
  const list = listById(view.id);
  if (!list.typeId) {
    const r = await typeDialog({ title: 'Tipo della lista', message: 'Per scegliere dal catalogo, indica di che tipo è questa lista.' });
    if (!r) return;
    list.typeId = resolveType(r);
    saveDb();
    render();
    if (!list.typeId) return;
  }
  openSheet();
}

const actions = {
  'menu': el => { ui.menu = ui.menu === el.dataset.key ? null : el.dataset.key; render(); },
  'back': () => history.back(),
  'hide-hint': () => { try { localStorage.setItem(HINT_KEY, '1'); } catch (e) { /* ignora */ } render(); },
  'nav-catalog': el => navigate({ name: 'catalog', typeId: el.dataset.type ? +el.dataset.type : null }),
  'open-list': el => { ui.newText = ''; navigate({ name: 'list', id: +el.dataset.id }); },

  'new-list': async () => {
    const r = await typeDialog({ title: 'Nuova lista', withName: true });
    if (!r) return;
    const typeId = resolveType(r);
    db.lists.push({ id: newId(), name: r.name, createdAt: Date.now(), typeId, items: [] });
    commit();
  },
  'import-paste': async () => {
    let clip = '';
    try { clip = await navigator.clipboard.readText(); } catch (e) { /* permesso negato */ }
    const text = await promptDialog('Importa da link', 'Incolla il link o il messaggio ricevuto', findData(clip) ? clip : '', 'Importa');
    if (text && !(await handleIncoming(text))) await infoDialog('Link non valido', '<p>Il testo non contiene un link di ApnAppLis.</p>');
  },

  // Dettaglio lista
  'toggle': el => { const it = findListItem(+el.dataset.id); if (it) { it.done = !it.done; commit(); } },
  'edit-item': async el => {
    const it = findListItem(+el.dataset.id);
    const t = it && await promptDialog('Modifica elemento', 'Testo', it.text);
    if (t) { it.text = t; commit(); }
  },
  'del-item': el => { const l = listById(view.id); l.items = l.items.filter(i => i.id !== +el.dataset.id); commit(); },
  'add-item': addItem,
  'open-picker': openPicker,
  'share-list': () => { const l = listById(view.id); share(exportList(l), l.name); },
  'rename-list': async () => {
    const l = listById(view.id);
    const t = await promptDialog('Rinomina lista', 'Nome della lista', l.name);
    if (t) { l.name = t; commit(); }
  },
  'change-type': async () => {
    const l = listById(view.id);
    const r = await typeDialog({ title: 'Tipo della lista', current: l.typeId });
    if (r) { l.typeId = resolveType(r); commit(); }
  },
  'sort-az': () => { const l = listById(view.id); l.items.sort((a, b) => a.text.localeCompare(b.text, 'it', { sensitivity: 'base' })); commit(); },
  'done-bottom': () => { const l = listById(view.id); l.items = [...l.items.filter(i => !i.done), ...l.items.filter(i => i.done)]; commit(); },
  'clear-done': () => { const l = listById(view.id); l.items = l.items.filter(i => !i.done); commit(); },
  'delete-list': async () => {
    if (!(await confirmDialog('Eliminare la lista e tutti i suoi elementi?'))) return;
    db.lists = db.lists.filter(l => l.id !== view.id);
    saveDb();
    history.back();
  },

  // Scelta dal catalogo
  'pk-close-bg': (el, e) => { if (e.target === el) closeSheet(); },
  'pk-cat': el => { const s = ui.picker.collapsed, id = +el.dataset.id; s.has(id) ? s.delete(id) : s.add(id); renderSheet(); },
  'pk-toggle': el => { const s = ui.picker.selected, id = +el.dataset.id; s.has(id) ? s.delete(id) : s.add(id); renderSheet(); },
  'pk-new-item': el => {
    ui.picker.newItemFor = +el.dataset.id; ui.picker.newItemText = ''; renderSheet();
    const input = document.getElementById('pk-new-input'); if (input) input.focus();
  },
  'pk-save-item': el => pickerSaveItem(+el.dataset.id),
  'pk-new-cat': async () => {
    const name = await promptDialog('Nuova categoria', 'Nome della categoria (es. Frutta)', '', 'Crea');
    const list = listById(view.id), type = list && typeById(list.typeId);
    if (!name || !type) return;
    const cat = ensureCategory(type, name);
    ui.picker.collapsed.delete(cat.id);
    ui.picker.newItemFor = cat.id; ui.picker.newItemText = '';
    commit();
    const input = document.getElementById('pk-new-input'); if (input) input.focus();
  },
  'pk-confirm': () => {
    const list = listById(view.id), type = typeById(list.typeId);
    const chosen = type.categories.flatMap(c => c.items.map(i => ({ item: i, cat: c }))).filter(x => ui.picker.selected.has(x.item.id));
    for (const { item, cat } of chosen) {
      const old = list.items.find(i => same(i.text, item.name));
      if (!old) list.items.push({ id: newId(), text: item.name, done: false, categoryId: cat.id });
      else if (old.done) { old.done = false; if (old.categoryId == null) old.categoryId = cat.id; }
    }
    ui.picker = null;
    commit();
  },
  'pk-manage': () => { const l = listById(view.id); ui.picker = null; navigate({ name: 'catalog', typeId: l.typeId }); },

  // Catalogo
  'select-type': el => { view.typeId = +el.dataset.id; history.replaceState({ view }, '', baseUrl()); render(); },
  'new-type': async () => {
    const name = await promptDialog('Nuovo tipo di lista', 'Nome (es. Spesa, Valigia)', '', 'Crea');
    if (!name) return;
    const t = ensureType(name);
    view.typeId = t.id;
    history.replaceState({ view }, '', baseUrl());
    commit();
  },
  'type-share': () => { const t = currentCatalogType(); share(exportCatalog(t), `Catalogo «${t.name}»`); },
  'type-rename': async () => {
    const t = currentCatalogType();
    const name = await promptDialog('Rinomina tipo', 'Nome', t.name);
    if (name) { t.name = name; commit(); }
  },
  'type-move': el => { moveInArray(db.types, db.types.indexOf(currentCatalogType()), +el.dataset.delta); commit(); },
  'type-delete': async () => {
    const t = currentCatalogType();
    if (!(await confirmDialog(`Eliminare «${t.name}» con tutte le sue categorie e voci? Le liste esistenti restano, senza tipo.`))) return;
    db.types = db.types.filter(x => x.id !== t.id);
    for (const l of db.lists) if (l.typeId === t.id) l.typeId = null;
    view.typeId = null;
    commit();
  },
  'new-category': async () => {
    const t = currentCatalogType();
    const name = await promptDialog('Nuova categoria', 'Nome (es. Frutta)', '', 'Crea');
    if (name) { ensureCategory(t, name); commit(); }
  },
  'cat-toggle': (el, e) => {
    if (e.target.closest('.menu-wrap')) return;
    const id = +el.dataset.id; ui.collapsed.has(id) ? ui.collapsed.delete(id) : ui.collapsed.add(id); render();
  },
  'cat-add-item': async el => {
    const c = currentCatalogType().categories.find(x => x.id === +el.dataset.id);
    const name = await promptDialog(`Nuova voce in ${c.name}`, 'Nome (es. Mele)', '', 'Aggiungi');
    if (name) { ensureItem(c, name); ui.collapsed.delete(c.id); commit(); }
  },
  'cat-rename': async el => {
    const c = currentCatalogType().categories.find(x => x.id === +el.dataset.id);
    const name = await promptDialog('Rinomina categoria', 'Nome', c.name);
    if (name) { c.name = name; commit(); }
  },
  'cat-move': el => {
    const cats = currentCatalogType().categories;
    moveInArray(cats, cats.findIndex(x => x.id === +el.dataset.id), +el.dataset.delta); commit();
  },
  'cat-delete': async el => {
    const t = currentCatalogType(), c = t.categories.find(x => x.id === +el.dataset.id);
    if (!(await confirmDialog(`Eliminare la categoria «${c.name}» e le sue voci? Nelle liste gli elementi restano, sotto «Altro».`))) return;
    t.categories = t.categories.filter(x => x.id !== c.id);
    for (const l of db.lists) for (const i of l.items) if (i.categoryId === c.id) i.categoryId = null;
    commit();
  },
  'item-rename': async el => {
    const c = currentCatalogType().categories.find(x => x.id === +el.dataset.cat);
    const it = c.items.find(x => x.id === +el.dataset.id);
    const name = await promptDialog('Rinomina voce', 'Nome', it.name);
    if (name) { it.name = name; commit(); }
  },
  'item-move': el => {
    const c = currentCatalogType().categories.find(x => x.id === +el.dataset.cat);
    moveInArray(c.items, c.items.findIndex(x => x.id === +el.dataset.id), +el.dataset.delta); commit();
  },
  'item-delete': el => {
    const c = currentCatalogType().categories.find(x => x.id === +el.dataset.cat);
    c.items = c.items.filter(x => x.id !== +el.dataset.id); commit();
  }
};

// ---------------------------------------------------------------- Eventi
document.addEventListener('click', e => {
  if (e.target.closest('#modal')) return;
  const el = e.target.closest('[data-act]');
  const act = el && el.dataset.act;
  // Un tocco fuori dal menu aperto lo chiude
  if (ui.menu && act !== 'menu' && !e.target.closest('.menu-pop')) {
    ui.menu = null;
    render();
    if (!act || el.closest('.menu-wrap')) return;
  }
  if (!act || el.disabled) return;
  if (ui.menu && e.target.closest('.menu-pop')) { ui.menu = null; render(); }
  const fn = actions[act];
  if (fn) fn(el, e);
});

document.addEventListener('input', e => {
  if (e.target.id === 'add-input') {
    ui.newText = e.target.value;
    const btn = document.querySelector('[data-act="add-item"]');
    if (btn) btn.disabled = !ui.newText.trim();
  } else if (e.target.id === 'pk-new-input' && ui.picker) {
    ui.picker.newItemText = e.target.value;
  }
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target.closest('#modal')) return;
  if (e.target.id === 'add-input') { e.preventDefault(); addItem(); }
  else if (e.target.id === 'pk-new-input') { e.preventDefault(); pickerSaveItem(+e.target.dataset.cat); }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && ui.picker && !document.getElementById('modal').innerHTML) closeSheet();
});

// ---------------------------------------------------------------- Avvio
(async function start() {
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* facoltativo */ }
  const incoming = location.hash;
  if (history.state && history.state.view) view = history.state.view;   // ricaricamento della pagina
  history.replaceState({ view }, '', baseUrl());   // toglie i dati dal link
  render();
  if (findData(incoming)) await handleIncoming(incoming);
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* funziona anche senza */ });
  }
})();
