/* Three screens, one decision each: which kind of label, which item, then the
   label itself. The server owns everything that decides what a label says --
   which items a type applies to, what is already known, what still has to be
   typed -- so this file only draws what it is handed. */

const el = (id) => document.getElementById(id);
const state = { type: null, item: null, form: null, config: {}, timer: null };

const ICONS = {
  /* Four marks that differ in silhouette rather than in detail, because the
     person picking one is glancing, not reading. */
  "goods-in": '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M12 3v9"/><path d="M8.5 9.5L12 13l3.5-3.5"/>',
  "date-opened": '<path d="M3 9l9-5 9 5v7l-9 5-9-5z"/><path d="M3 9l9 4 9-4"/><path d="M7 6.5L12 9l5-2.5"/><path d="M12 13v8"/>',
  "packet": '<path d="M6 7h12l-1 13H7z"/><path d="M9 7V5a3 3 0 0 1 6 0v2"/><path d="M9.5 12h5"/>',
  "box": '<path d="M2 7h20v12H2z"/><path d="M2 7l3-4h14l3 4"/><path d="M12 3v4"/><path d="M8 12h8"/>',
};

async function api(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function show(screen) {
  for (const id of ["types", "items", "label"]) {
    el(`screen-${id}`).hidden = id !== screen;
  }
  el("back").hidden = screen === "types";
}

/* --- 1. the four types ----------------------------------------------------- */

function drawTypes(types) {
  el("tiles").replaceChildren(...types.map((type) => {
    const tile = document.createElement("button");
    tile.className = "tile";
    tile.innerHTML =
      `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[type.id] || ""}</svg>` +
      `<strong></strong><span></span>`;
    tile.querySelector("strong").textContent = type.name;
    tile.querySelector("span").textContent = type.blurb;
    tile.onclick = () => openType(type);
    return tile;
  }));
}

/* --- 2. the item list ------------------------------------------------------ */

async function openType(type) {
  state.type = type;
  el("title").textContent = type.name;
  show("items");
  el("search").value = "";
  const { items } = await api(`/api/items/${type.id}`);
  state.items = items;
  drawItems("");
  el("search").focus();
}

function drawItems(query) {
  const needle = query.trim().toLowerCase();
  const matches = state.items.filter((item) =>
    item.name.toLowerCase().includes(needle));
  el("items-empty").hidden = matches.length > 0;
  el("items").replaceChildren(...matches.map((item) => {
    const row = document.createElement("li");
    const button = document.createElement("button");
    const name = document.createElement("strong");
    name.textContent = item.name;
    button.append(name);
    if (item.incomplete) {
      /* Not a warning about the label, which prints fine -- a note that some
         of what it says had to be typed rather than looked up. */
      const flag = document.createElement("span");
      flag.className = "flag";
      flag.textContent = "needs filling";
      button.append(flag);
    }
    const detail = document.createElement("em");
    detail.textContent = item.detail;
    button.append(detail);
    button.onclick = () => openLabel(item);
    row.append(button);
    return row;
  }));
}

/* --- 3. the label ---------------------------------------------------------- */

async function openLabel(item) {
  state.item = item;
  el("title").textContent = `${state.type.name} — ${item.name}`;
  show("label");
  el("quantity").value = 1;
  el("messages").replaceChildren();
  state.form = await api(`/api/form/${state.type.id}/${encodeURIComponent(item.id)}`);
  drawFields(state.form.fields);
  render();
}

function drawFields(fields) {
  el("fields").replaceChildren(...fields.map((field) => {
    const wrap = document.createElement("div");
    wrap.className = "field" + (field.missing ? " gap" : "");

    const label = document.createElement("label");
    label.textContent = field.label;
    label.htmlFor = `f-${field.key}`;
    wrap.append(label);

    let input;
    if (field.kind === "select") {
      input = document.createElement("select");
      input.append(...field.options.map((option) => {
        const node = document.createElement("option");
        node.value = node.textContent = option;
        return node;
      }));
      input.value = field.value;
    } else {
      input = document.createElement("input");
      input.type = field.kind === "date" ? "date" : "text";
      input.value = field.value;
    }
    input.id = `f-${field.key}`;
    input.dataset.key = field.key;
    input.disabled = !field.editable;
    input.addEventListener("input", scheduleRender);
    wrap.append(input);

    if (field.hint) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = field.hint;
      wrap.append(hint);
    }
    return wrap;
  }));
}

function values() {
  const out = {};
  for (const input of el("fields").querySelectorAll("[data-key]")) {
    out[input.dataset.key] = input.value;
  }
  return out;
}

function scheduleRender() {
  /* Every keystroke would be a round trip to Labelary, so wait for a pause.
     Long enough not to fire mid-word, short enough that the preview feels
     like it belongs to the field being typed in. */
  clearTimeout(state.timer);
  state.timer = setTimeout(render, 450);
}

async function render() {
  const preview = el("preview");
  try {
    const result = await api("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: state.type.id, item: state.item.id,
        values: values(), quantity: Number(el("quantity").value) || 1,
      }),
    });
    el("zpl").textContent = result.zpl;
    if (result.png) {
      const image = document.createElement("img");
      image.src = `data:image/png;base64,${result.png}`;
      image.alt = "The label as it will print";
      preview.replaceChildren(image);
    } else {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = result.preview_error ||
        "Preview is switched off. The ZPL below is what will be sent.";
      preview.replaceChildren(note);
    }
    setMessages(result.warnings.map((text) => ["warn", text]));
  } catch (error) {
    setMessages([["bad", error.message]]);
  }
}

function setMessages(entries) {
  el("messages").replaceChildren(...entries.map(([kind, text]) => {
    const node = document.createElement("div");
    node.className = `msg ${kind}`;
    node.textContent = text;
    return node;
  }));
}

async function print() {
  const button = el("print");
  button.disabled = true;
  button.textContent = "Printing…";
  try {
    const result = await api("/api/print", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: state.type.id, item: state.item.id,
        values: values(), quantity: Number(el("quantity").value) || 1,
      }),
    });
    const copies = Number(el("quantity").value) || 1;
    setMessages([
      ["ok", `Sent. ${copies} ${copies === 1 ? "label" : "labels"} — ${result.message}`],
      ...result.warnings.map((text) => ["warn", text]),
    ]);
  } catch (error) {
    setMessages([["bad", `Nothing printed. ${error.message}`]]);
  } finally {
    button.disabled = false;
    button.textContent = "Print";
  }
}

/* --- settings -------------------------------------------------------------- */

function drawSettings(boot) {
  const config = state.config = boot.config;
  el("backend").value = config.backend;
  el("share").value = config.share;
  el("host").value = config.host;
  el("folder").value = config.folder;
  el("preview-on").checked = config.preview;

  const printer = el("printer");
  const names = boot.printers.length ? boot.printers : ["(none found)"];
  printer.replaceChildren(...names.map((name) => {
    const node = document.createElement("option");
    node.value = node.textContent = name;
    return node;
  }));
  if (config.printer) printer.value = config.printer;

  const pill = el("printer-pill");
  const route = config.backend === "auto" ? boot.backend : config.backend;
  const target = { winspool: config.printer || boot.printers[0] || "no printer",
                   share: `\\\\localhost\\${config.share}`,
                   tcp: config.host || "no address",
                   folder: "folder only" }[route] || route;
  pill.textContent = `${route} — ${target}`;
  pill.className = "pill " + (route === "folder" ? "" : "ok");
  showRelevant();
}

function showRelevant() {
  const chosen = el("backend").value;
  const effective = chosen === "auto"
    ? (state.boot.windows ? "winspool" : "folder") : chosen;
  for (const field of document.querySelectorAll("[data-for]")) {
    field.hidden = field.dataset.for !== effective;
  }
}

async function saveSettings() {
  const boot = await api("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      backend: el("backend").value,
      // The select shows a placeholder when Windows reports no printers;
      // storing that as a name would fail at print time with a confusing error.
      printer: el("printer").value.startsWith("(") ? "" : el("printer").value,
      share: el("share").value,
      host: el("host").value,
      folder: el("folder").value,
      preview: el("preview-on").checked,
    }),
  });
  state.boot.config = boot.config;
  drawSettings(state.boot);
}

/* --- wiring ---------------------------------------------------------------- */

el("back").onclick = () => {
  if (!el("screen-label").hidden) {
    el("title").textContent = state.type.name;
    show("items");
  } else {
    el("title").textContent = "Labels";
    show("types");
  }
};
el("search").addEventListener("input", (event) => drawItems(event.target.value));
el("search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const first = el("items").querySelector("button");
    if (first) first.click();
  }
});
el("quantity").addEventListener("input", scheduleRender);
el("print").onclick = print;
el("open-settings").onclick = () => el("settings").showModal();
el("backend").onchange = showRelevant;
el("settings").addEventListener("close", () => {
  if (el("settings").returnValue === "save") saveSettings();
});

(async function start() {
  const boot = state.boot = await api("/api/bootstrap");
  drawTypes(boot.types);
  drawSettings(boot);
  show("types");
})();
