/* Three screens, one decision each: which kind of label, which item, then the
   label itself. The server owns everything that decides what a label says --
   which items a type applies to, what is already known, what still has to be
   typed -- so this file only draws what it is handed. */

const el = (id) => document.getElementById(id);
const state = { type: null, item: null, form: null, config: {}, timer: null,
                today: null, revision: 0, prepared: null,
                prepareController: null, previewController: null };

/* Today, as the value a date input holds. */
function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-` +
         `${String(now.getDate()).padStart(2, "0")}`;
}

const ICONS = {
  /* Four marks that differ in silhouette rather than in detail, because the
     person picking one is glancing, not reading. */
  "goods-in": '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M12 3v9"/><path d="M8.5 9.5L12 13l3.5-3.5"/>',
  "date-opened": '<path d="M3 9l9-5 9 5v7l-9 5-9-5z"/><path d="M3 9l9 4 9-4"/><path d="M7 6.5L12 9l5-2.5"/><path d="M12 13v8"/>',
  "packet": '<path d="M6 7h12l-1 13H7z"/><path d="M9 7V5a3 3 0 0 1 6 0v2"/><path d="M9.5 12h5"/>',
  "box": '<path d="M2 7h20v12H2z"/><path d="M2 7l3-4h14l3 4"/><path d="M12 3v4"/><path d="M8 12h8"/>',
  "notice": '<path d="M3 5h18v14H3z"/><path d="M7 10h10"/><path d="M7 14h6"/>',
  "box-seal": '<circle cx="12" cy="12" r="8"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
};

async function api(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
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
    tile.onclick = () => (type.source === "free"
      ? openLabel({ id: "-", name: type.name }, type)
      : openType(type));
    return tile;
  }));
}

/* --- 2. the item list ------------------------------------------------------ */

async function openType(type) {
  state.type = type;
  /* The hash makes a view bookmarkable, so the machine at the printer can be
     left on the list -- or on the one label it prints all day -- rather than
     starting from the tiles each time. */
  location.hash = type.id;
  el("title").textContent = type.name;
  show("items");
  el("search").value = "";
  await loadItems();
  el("search").focus();
}

async function loadItems() {
  const { groups } = await api(`/api/items/${state.type.id}`);
  state.groups = groups;
  drawItems(el("search").value);
}

function drawItems(query) {
  const needle = query.trim().toLowerCase();
  const sections = [];
  let total = 0;

  for (const group of state.groups) {
    /* Filter first, then draw: a supplier or a storage area with nothing left
       in it after a search should disappear rather than sit there as an empty
       heading. */
    const kept = group.sections
      .map((section) => ({
        name: section.name,
        items: section.items.filter((item) =>
          item.name.toLowerCase().includes(needle)),
      }))
      .filter((section) => section.items.length);
    if (!kept.length) continue;

    const count = kept.reduce((sum, section) => sum + section.items.length, 0);
    total += count;

    if (group.name) {
      const heading = document.createElement("h2");
      heading.className = "group";
      heading.textContent = group.name;
      const badge = document.createElement("span");
      badge.textContent = count;
      heading.append(badge);
      sections.push(heading);
    }

    for (const section of kept) {
      if (section.name) {
        const subheading = document.createElement("h3");
        subheading.className = "section";
        subheading.textContent = section.name;
        sections.push(subheading);
      }
      const list = document.createElement("ul");
      list.className = "items";
      list.append(...section.items.map(itemRow));
      sections.push(list);
    }
  }

  el("items-empty").hidden = total > 0;
  el("items").replaceChildren(...sections);
}

function itemRow(item) {
  const row = document.createElement("li");
  const button = document.createElement("button");

  /* The photograph is how the kitchen already recognises an ingredient: the
     catalog names differ from what is written on the box, and a jar is
     quicker to match by sight than by reading "Toban Djan Chilli Bean
     Sauce". Ten ingredients have no photograph and get an initial instead,
     which keeps the rows the same height and the grid aligned. */
  if (item.photo) {
    const image = document.createElement("img");
    image.className = "thumb";
    image.loading = "lazy";
    image.src = `/photos/${encodeURIComponent(item.id)}.jpg`;
    image.alt = "";
    button.append(image);
  } else {
    const stand = document.createElement("span");
    stand.className = "thumb none";
    stand.textContent = item.name.trim()[0] || "?";
    button.append(stand);
  }

  const text = document.createElement("span");
  text.className = "text";
  const name = document.createElement("strong");
  name.textContent = item.name;
  text.append(name);
  const detail = document.createElement("em");
  detail.textContent = item.detail;
  text.append(detail);
  button.append(text);

  if (item.incomplete) {
    /* Not a warning about the label, which prints fine -- a note that some of
       what it says had to be typed rather than looked up. */
    const flag = document.createElement("span");
    flag.className = "flag";
    flag.textContent = "needs filling";
    button.append(flag);
  }

  button.onclick = () => openLabel(item);
  row.append(button);
  return row;
}

/* --- 3. the label ---------------------------------------------------------- */

async function openLabel(item, type) {
  if (type) state.type = type;
  state.item = item;
  const supplier = state.type.id === "goods-in" && item.supplier
    ? `?supplier=${encodeURIComponent(item.supplier)}` : "";
  location.hash = `${state.type.id}/${encodeURIComponent(item.id)}${supplier}`;
  el("title").textContent = state.type.source === "free"
    ? state.type.name : `${state.type.name} — ${item.name}`;
  show("label");
  el("quantity").value = 1;
  beginRevision();
  const formSupplier = state.type.id === "goods-in" && item.supplier
    ? `?supplier=${encodeURIComponent(item.supplier)}` : "";
  state.form = await api(
    `/api/form/${state.type.id}/${encodeURIComponent(item.id)}${formSupplier}`);
  state.today = todayISO();
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
    let reset;
    if (field.kind === "choice") {
      /* A row of buttons rather than a dropdown: the pot number is picked on
         every print, often several times in a row, and a dropdown costs two
         clicks and a read where this costs one click and a glance. The value
         itself lives on a hidden input so it is collected like any other. */
      const row = document.createElement("div");
      row.className = "choices";
      input = document.createElement("input");
      input.type = "hidden";
      input.value = field.value;
      for (const option of field.options) {
        const choice = document.createElement("button");
        choice.type = "button";
        choice.textContent = option;
        choice.className = option === field.value ? "on" : "";
        choice.onclick = () => {
          input.value = option;
          for (const other of row.children) {
            other.classList.toggle("on", other === choice);
          }
          recompute();
          scheduleRender();
        };
        row.append(choice);
      }
      row.append(input);
      input.id = `f-${field.key}`;
      input.dataset.key = field.key;
      wrap.append(row);
      if (field.hint) {
        const hint = document.createElement("p");
        hint.className = "hint";
        hint.textContent = field.hint;
        wrap.append(hint);
      }
      return wrap;
    }
    if (field.kind === "select") {
      input = document.createElement("select");
      input.append(...field.options.map((option) => {
        const node = document.createElement("option");
        node.value = node.textContent = option;
        return node;
      }));
      input.value = field.value;
    } else if (field.kind === "lines") {
      input = document.createElement("textarea");
      input.rows = 3;
      input.value = field.value;
    } else {
      input = document.createElement("input");
      input.type = field.kind === "date" ? "date" : "text";
      input.value = field.value;
    }
    input.id = `f-${field.key}`;
    input.dataset.key = field.key;
    input.disabled = !field.editable;
    if (field.derive) {
      /* A derived field keeps working itself out until somebody types into it.
         After that it is theirs: the batch number is the date most of the
         time and a supplier's own code the rest of the time, and the second
         case must not be undone by touching the date afterwards. */
      input.dataset.derive = field.derive;
      reset = document.createElement("button");
      reset.type = "button";
      reset.className = "derive-reset";
      reset.textContent = "Use automatic value";
      reset.hidden = true;
      reset.onclick = () => {
        delete input.dataset.own;
        recompute();
        reset.hidden = true;
        scheduleRender();
      };
    }
    input.addEventListener("input", () => {
      if (input.dataset.derive) {
        input.dataset.own = "yes";
        reset.hidden = false;
      }
      recompute();
      scheduleRender();
    });
    wrap.append(input);
    if (reset) wrap.append(reset);

    if (field.hint) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = field.hint;
      wrap.append(hint);
    }
    return wrap;
  }));
}

function recompute() {
  const current = values();
  for (const input of el("fields").querySelectorAll("[data-derive]")) {
    if (input.dataset.own === "yes") continue;
    input.value = LabelLogic.derive(input.dataset.derive, current);
  }
}

/* The machine at the printer is left switched on, so a label screen can sit
   open across midnight. The dates on it were worked out when it was opened,
   and printing yesterday's delivery date onto today's delivery is the kind of
   quiet wrong answer this whole system exists to prevent.

   Only fields still holding the old date are moved on, so anything typed by
   hand is left exactly as it was, and the derived fields follow. */
function rollOver() {
  if (!state.today || el("screen-label").hidden) return;
  const today = todayISO();
  if (today === state.today) return;

  let moved = false;
  for (const input of el("fields").querySelectorAll('input[type="date"]')) {
    if (input.value === state.today && input.dataset.own !== "yes") {
      input.value = today;
      moved = true;
    }
  }
  state.today = today;
  if (moved) {
    recompute();
    render();
  }
}

function values() {
  const out = {};
  for (const input of el("fields").querySelectorAll("[data-key]")) {
    out[input.dataset.key] = input.value;
  }
  return out;
}

function labelPayload(preview) {
  return {
    type: state.type.id,
    item: state.item.id,
    values: values(),
    quantity: Number(el("quantity").value),
    preview,
  };
}

function previewNote(text) {
  const note = document.createElement("p");
  note.className = "muted";
  note.textContent = text;
  el("preview").replaceChildren(note);
}

function isSeal() {
  return state.type && state.type.source === "seal";
}

function beginRevision() {
  state.revision += 1;
  state.prepared = null;
  state.prepareController?.abort();
  state.previewController?.abort();
  el("print").disabled = true;
  el("messages").replaceChildren();
  if (isSeal()) {
    // Its own pane, not the ZPL/Labelary one: there is no PNG round trip to
    // wait on, so no "Updating preview…" placeholder either.
    el("preview").hidden = true;
    el("seal-preview").hidden = false;
    el("zpl-details").hidden = true;
    el("seal-details").hidden = false;
  } else {
    el("preview").hidden = false;
    el("seal-preview").hidden = true;
    el("zpl-details").hidden = false;
    el("seal-details").hidden = true;
    el("preview").setAttribute("aria-busy", "true");
    previewNote("Updating preview…");
  }
  return state.revision;
}

function scheduleRender() {
  clearTimeout(state.timer);
  const revision = beginRevision();
  state.timer = setTimeout(() => prepareLabel(revision), 450);
}

function render() {
  clearTimeout(state.timer);
  const revision = beginRevision();
  prepareLabel(revision);
}

async function prepareLabel(revision) {
  if (isSeal()) return prepareSeal(revision);
  const snapshot = labelPayload(false);
  const prepareController = new AbortController();
  const previewController = new AbortController();
  state.prepareController = prepareController;
  state.previewController = previewController;
  // Fired together rather than chained: the preview needs no result from the
  // fast call, only the same snapshot, so waiting for the fast round trip
  // to finish before starting the one that also waits on Labelary only adds
  // a second full round trip to every keystroke for nothing.
  const previewPromise = api("/api/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...snapshot, preview: true }),
    signal: previewController.signal,
  });

  let fingerprint;
  try {
    const result = await api("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
      signal: prepareController.signal,
    });
    if (revision !== state.revision) return;
    el("zpl").textContent = result.zpl;
    setMessages(result.warnings.map((text) => ["warn", text]));
    state.prepared = {
      revision,
      payload: snapshot,
      fingerprint: result.fingerprint,
      itemName: state.item.name,
    };
    el("print").disabled = false;
    fingerprint = result.fingerprint;
  } catch (error) {
    previewController.abort();
    if (error.name === "AbortError" || revision !== state.revision) return;
    el("preview").setAttribute("aria-busy", "false");
    previewNote("The label could not be prepared.");
    setMessages([["bad", error.message]]);
    return;
  }

  await loadPreview(revision, previewPromise, fingerprint);
}

async function loadPreview(revision, previewPromise, fingerprint) {
  try {
    const result = await previewPromise;
    if (revision !== state.revision) return;
    if (result.fingerprint !== fingerprint) {
      render();
      return;
    }
    if (result.png) {
      const image = document.createElement("img");
      image.src = `data:image/png;base64,${result.png}`;
      image.alt = "The label as it will print";
      el("preview").replaceChildren(image);
    } else {
      previewNote(result.preview_error ||
        "Preview is switched off. The prepared ZPL below is ready to print.");
    }
  } catch (error) {
    if (error.name === "AbortError" || revision !== state.revision) return;
    previewNote(`No visual preview: ${error.message}. The prepared label is ready.`);
  } finally {
    if (revision === state.revision) {
      el("preview").setAttribute("aria-busy", "false");
    }
  }
}

async function prepareSeal(revision) {
  const snapshot = labelPayload(false);
  const controller = new AbortController();
  state.prepareController = controller;
  try {
    const result = await api("/api/seal/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
      signal: controller.signal,
    });
    if (revision !== state.revision) return;
    el("seal-json").textContent = JSON.stringify(result.seal, null, 1);
    const encoded = SealPreview.draw(el("seal-canvas"), result.seal);
    if (encoded.error) {
      setMessages([["bad", encoded.error]]);
      return;
    }
    state.prepared = {
      revision, seal: result.seal, fingerprint: result.fingerprint,
      itemName: state.item.name,
    };
    el("print").disabled = false;
  } catch (error) {
    if (error.name === "AbortError" || revision !== state.revision) return;
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
  const prepared = state.prepared;
  if (!prepared || prepared.revision !== state.revision) {
    setMessages([["bad", "Wait for the current label to be prepared."]]);
    return;
  }
  const controls = [...el("fields").elements, el("quantity"), el("back"),
                    el("open-settings")];
  const disabledBefore = controls.map((control) => control.disabled);
  controls.forEach((control) => { control.disabled = true; });
  button.disabled = true;
  button.textContent = "Printing…";
  try {
    const seal = isSeal();
    const result = await api(seal ? "/api/seal/print" : "/api/print", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(seal ? {
        type: state.type.id, item: state.item.id,
        values: values(), quantity: Number(el("quantity").value),
        fingerprint: prepared.fingerprint,
      } : {
        ...prepared.payload,
        fingerprint: prepared.fingerprint,
      }),
    });
    const copies = Number(el("quantity").value);
    const batch = seal ? (prepared.seal.batch ? `, batch ${prepared.seal.batch}` : "")
      : (prepared.payload.values.batch ? `, batch ${prepared.payload.values.batch}` : "");
    setMessages([
      ["ok", `Sent ${copies} ${copies === 1 ? "label" : "labels"} for ` +
             `${prepared.itemName}${batch}. ${result.message}`],
      ...result.warnings.map((text) => ["warn", text]),
    ]);
  } catch (error) {
    if (error.status === 409) {
      render();
      setMessages([["warn", error.message]]);
    } else {
      setMessages([["bad", `Nothing printed. ${error.message}`]]);
    }
  } finally {
    controls.forEach((control, index) => {
      control.disabled = disabledBefore[index];
    });
    button.disabled = !state.prepared || state.prepared.revision !== state.revision;
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
  el("listen-network").checked = config.listen === "network";

  const printer = el("printer");
  const names = boot.printers.length ? boot.printers : ["(none found)"];
  printer.replaceChildren(...names.map((name) => {
    const node = document.createElement("option");
    node.value = node.textContent = name;
    return node;
  }));
  if (config.printer) printer.value = config.printer;

  const brotherPrinter = el("brother-printer");
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "(none selected)";
  brotherPrinter.replaceChildren(placeholder, ...boot.printers.map((name) => {
    const node = document.createElement("option");
    node.value = node.textContent = name;
    return node;
  }));
  brotherPrinter.value = config.brother_printer || "";

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
      brother_printer: el("brother-printer").value,
      share: el("share").value,
      host: el("host").value,
      folder: el("folder").value,
      preview: el("preview-on").checked,
      listen: el("listen-network").checked ? "network" : "local",
    }),
  });
  state.boot.config = boot.config;
  drawSettings(state.boot);
}

/* --- wiring ---------------------------------------------------------------- */

el("back").onclick = () => {
  /* A label with no list behind it goes straight back to the tiles; there is
     no middle screen to return to. */
  if (!el("screen-label").hidden && state.type.source !== "free") {
    el("title").textContent = state.type.name;
    location.hash = state.type.id;
    show("items");
  } else {
    el("title").textContent = "Labels";
    location.hash = "";
    show("types");
  }
};
el("search").addEventListener("input", (event) => drawItems(event.target.value));
el("search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const first = el("items").querySelector(".items button");
    if (first) first.click();
  }
});
el("quantity").addEventListener("input", scheduleRender);
el("print").onclick = print;
/* Checked when the window is looked at again and once a minute regardless,
   since a machine left running all night is never "focused" at midnight. */
window.addEventListener("focus", rollOver);
document.addEventListener("visibilitychange", rollOver);
setInterval(rollOver, 60000);
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
  const [hashPath, hashQuery = ""] = location.hash.slice(1).split("?");
  const [typeId, encodedItemId] = hashPath.split("/");
  const itemId = encodedItemId ? decodeURIComponent(encodedItemId) : "";
  const supplier = new URLSearchParams(hashQuery).get("supplier");
  const wanted = boot.types.find((t) => t.id === typeId);
  if (!wanted) return;
  await openType(wanted);
  if (itemId) {
    const item = state.groups
      .flatMap((group) => group.sections)
      .flatMap((section) => section.items)
      .find((candidate) => candidate.id === itemId &&
        (!supplier || candidate.supplier === supplier));
    if (item) await openLabel(item);
  }
})();
