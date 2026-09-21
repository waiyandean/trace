/* Canvas preview for the Box Seal label -- mirrors worker/scripts/
   brother_seal.py's EAN-13 encoder and layout: the same rectangles, in
   points, read off MR024 Hell Ramen.lbx. */
const SealPreview = (() => {
  const L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
  const G = ["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
  const R = ["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];
  const PARITY = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];

  // Layout in points, read straight off MR024 Hell Ramen.lbx's object
  // rectangles [x, y, width, height]. The .lbx is a landscape page: x runs
  // along the feed and y across the 62mm tape, so the label is short and
  // wide-tape -- about 44mm by 62mm -- and is drawn here upright, x to the
  // right and y down, as it comes off the printer. See brother_seal.py.
  const PAGE_START_X_PT = 8.4;
  const PAGE_END_X_PT = 117.5;
  const PAGE_W_PT = PAGE_END_X_PT + PAGE_START_X_PT; // the leading margin repeated at the end
  const PAGE_H_PT = (62 / 25.4) * 72;                // the tape's width
  const LABEL_LENGTH_MM = (PAGE_W_PT / 72) * 25.4;
  const TAPE_WIDTH_MM = 62;
  const NAME_BOX = [49.8, 4.4, 26.3, 5.7];
  const NAME_PT = 5;
  const BARCODE_BOX = [10.4, 10.4, 105.1, 72];
  const BAR_MODULE_PT = 0.72; // 3 dots at 300dpi: the printer draws 0.8pt as a whole number of dots
  const DIGIT_PT = 7;
  const DOWN_PT = 8.5; // everything below the barcode, 3mm lower than the .lbx has it
  const BATCH_LABEL_BOX = [PAGE_START_X_PT, 90 + DOWN_PT, PAGE_END_X_PT - PAGE_START_X_PT, 8];
  const BATCH_VALUE_BOX = [PAGE_START_X_PT, 98 + DOWN_PT, PAGE_END_X_PT - PAGE_START_X_PT, 14];
  const BEST_LABEL_BOX = [PAGE_START_X_PT, 113 + DOWN_PT, PAGE_END_X_PT - PAGE_START_X_PT, 8];
  const BEST_VALUE_BOX = [PAGE_START_X_PT, 121 + DOWN_PT, PAGE_END_X_PT - PAGE_START_X_PT, 14];
  const LABEL_PT = 7;
  const VALUE_PT = 12;
  // The .lbx clipart box is 48 x 28pt; the oval inside it, measured off the printed reference, is about 36 x 21pt.
  const OVAL_BOX = [44.9, 139.9 + DOWN_PT, 36, 21];
  const OVAL_PEN_PT = 1.5;
  const HM_BOX = [51.4, 142.4 + DOWN_PT, 23, 16.2];
  const HM_PT = 7;
  const SCALE = 4; // canvas pixels per point

  function checkDigit(twelve) {
    let total = 0;
    for (let i = 0; i < 12; i++) total += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (total % 10)) % 10;
  }

  function ean13Bars(raw) {
    let digits = String(raw).replace(/[^0-9]/g, "");
    if (digits.length !== 12 && digits.length !== 13) {
      return { error: `${JSON.stringify(raw)} is not an EAN-13 -- ${digits.length} digits, not 12 or 13` };
    }
    if (digits.length === 12) {
      digits = digits + String(checkDigit(digits));
    } else if (Number(digits[12]) !== checkDigit(digits.slice(0, 12))) {
      const want = checkDigit(digits.slice(0, 12));
      return { error: `${digits} has the wrong check digit: the first twelve give ${want}, not ${digits[12]}` };
    }
    const first = digits[0], left = digits.slice(1, 7), right = digits.slice(7, 13);
    const parity = PARITY[Number(first)];
    let bars = "101";
    for (let i = 0; i < 6; i++) bars += (parity[i] === "L" ? L : G)[Number(left[i])];
    bars += "01010";
    for (let i = 0; i < 6; i++) bars += R[Number(right[i])];
    bars += "101";
    return { digits, bars };
  }

  /* `seal` matches the shape /api/labels/seal-render returns: { name, batch,
     useBy (dd/mm/yyyy), barcode, healthMark, hmCountry, hmCode }. Returns the
     ean13Bars() result so callers can surface a bad-barcode error. The canvas
     is sized here, from the label's own dimensions. */
  function draw(canvas, seal) {
    canvas.width = Math.round(PAGE_W_PT * SCALE);
    canvas.height = Math.round(PAGE_H_PT * SCALE);
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    const pt = (v) => v * SCALE;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#d9d9e0";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, w - 2, h - 2);
    ctx.fillStyle = "#1b1b1f";
    ctx.textBaseline = "middle";

    const SANS = '-apple-system, "Segoe UI", system-ui, sans-serif';
    const MONO = '"Consolas", ui-monospace, "SF Mono", "Segoe UI Mono", monospace';

    // Text vertically centred in its box and aligned within it, as the
    // .lbx's CENTER alignment does.
    function textIn(box, text, size, align, weight, family) {
      const [x, y, bw, bh] = box.map(pt);
      ctx.font = `${weight} ${Math.round(pt(size))}px ${family}`;
      ctx.textAlign = align;
      const ax = align === "center" ? x + bw / 2 : align === "right" ? x + bw : x;
      ctx.fillText(text, ax, y + bh / 2);
    }

    // The catalog's internal name is "Frozen Ramen : Hell Ramen"; the box only
    // carries the product's own name.
    const name = String(seal.name || "").split(":").pop().trim();
    if (name) textIn(NAME_BOX, name, NAME_PT, "center", 400, SANS);

    const result = ean13Bars(seal.barcode);
    if (!result.error) {
      const [bx, by, bw, bh] = BARCODE_BOX.map(pt);
      const module = pt(BAR_MODULE_PT);
      const x = bx + (bw - module * result.bars.length) / 2;
      const textH = pt(DIGIT_PT) * 1.15;
      const barH = bh - textH;
      const isGuard = (i) => i < 3 || (i >= 45 && i < 50) || i >= 92;
      ctx.fillStyle = "#000";
      for (let i = 0; i < result.bars.length; i++) {
        if (result.bars[i] !== "1") continue;
        const left = Math.round(x + i * module);
        const right = Math.round(x + (i + 1) * module);
        const bottom = isGuard(i) ? by + bh - textH / 3 : by + barH;
        ctx.fillRect(left, by, right - left, bottom - by);
      }
      ctx.fillStyle = "#1b1b1f";
      const digitBox = (m0, mw) => [(x + m0 * module) / SCALE, (by + barH) / SCALE, (mw * module) / SCALE, textH / SCALE];
      textIn(digitBox(-8, 7), result.digits[0], DIGIT_PT, "right", 400, MONO);
      textIn(digitBox(3, 42), result.digits.slice(1, 7), DIGIT_PT, "center", 400, MONO);
      textIn(digitBox(50, 42), result.digits.slice(7, 13), DIGIT_PT, "center", 400, MONO);
    }

    // Each label stacked above its value, centred: a redesign of the .lbx's
    // two right-aligned columns, chosen from printed trials.
    textIn(BATCH_LABEL_BOX, "Batch", LABEL_PT, "center", 400, SANS);
    textIn(BATCH_VALUE_BOX, String(seal.batch || ""), VALUE_PT, "center", 700, MONO);
    textIn(BEST_LABEL_BOX, "Best Before", LABEL_PT, "center", 400, SANS);
    textIn(BEST_VALUE_BOX, String(seal.useBy || ""), VALUE_PT, "center", 700, MONO);

    if (seal.healthMark) {
      const [ox, oy, ow, oh] = OVAL_BOX.map(pt);
      ctx.strokeStyle = "#1b1b1f";
      ctx.lineWidth = pt(OVAL_PEN_PT);
      ctx.beginPath();
      ctx.ellipse(ox + ow / 2, oy + oh / 2, ow / 2, oh / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#1b1b1f";
      // One two-line object in the .lbx; each line is half its box's height.
      const [hx, hy, hw, hh] = HM_BOX;
      textIn([hx, hy, hw, hh / 2], seal.hmCountry || "GB", HM_PT, "center", 700, SANS);
      textIn([hx, hy + hh / 2, hw, hh / 2], seal.hmCode || "", HM_PT, "center", 700, SANS);
    }

    return result;
  }

  return { draw, ean13Bars, LABEL_LENGTH_MM, TAPE_WIDTH_MM };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = SealPreview;
}
