const LabelLogic = (() => {
  const BATCH_SUFFIX = "GA";

  function isoParts(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    if (!match) return null;
    const [, year, month, day] = match;
    const instant = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (instant.getUTCFullYear() !== Number(year) ||
        instant.getUTCMonth() + 1 !== Number(month) ||
        instant.getUTCDate() !== Number(day)) return null;
    return { year, month, day, instant };
  }

  function isoDate(instant) {
    return `${instant.getUTCFullYear()}-` +
      `${String(instant.getUTCMonth() + 1).padStart(2, "0")}-` +
      `${String(instant.getUTCDate()).padStart(2, "0")}`;
  }

  function derive(kind, current) {
    let source;
    if (kind === "ddmmyy") source = current.delivered;
    else if (kind && kind.startsWith("days:")) source = current.opened;
    else source = current.packed;

    const parts = isoParts(source);
    if (!parts) return "";
    const { year, month, day, instant } = parts;

    if (kind === "ddmmyy") return `${day}${month}${year.slice(2)}`;
    if (kind === "batch") {
      return `${day}${month}${BATCH_SUFFIX}${current.pot || ""}`;
    }
    if (kind && kind.startsWith("days:")) {
      const days = Number(kind.slice(5));
      if (!Number.isInteger(days) || days < 0) return "";
      instant.setUTCDate(instant.getUTCDate() + days);
      return isoDate(instant);
    }

    if (kind && kind.startsWith("years:")) {
      const years = Number(kind.slice(6));
      if (!Number.isInteger(years) || years < 1) return "";
      // Same day and month, year + N. The one day that can't exist -- 29 Feb
      // landing on a non-leap year -- falls back to 28 Feb, mirroring
      // years_on() in server.py rather than raising.
      const wanted = Date.UTC(Number(year) + years, Number(month) - 1, Number(day));
      const landed = new Date(wanted);
      if (landed.getUTCMonth() !== Number(month) - 1) {
        landed.setUTCDate(0);
      }
      return isoDate(landed);
    }

    const months = kind && kind.startsWith("months:") ? Number(kind.slice(7)) : 0;
    if (!Number.isInteger(months) || months < 1) return "";
    const total = Number(year) * 12 + (Number(month) - 1) + months;
    const onward = String(Math.floor(total / 12));
    const at = String((total % 12) + 1).padStart(2, "0");
    return `${onward}-${at}-01`;
  }

  return { derive };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LabelLogic;
}
