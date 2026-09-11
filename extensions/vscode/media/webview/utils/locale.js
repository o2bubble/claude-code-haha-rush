/* ═══════════════════════════════════════════════════
   LOCALE — Internationalisation (i18n)
   Uses __localeData injected from template.html
   ═══════════════════════════════════════════════════ */

var __localeData = typeof __localeData !== 'undefined' ? __localeData : {};

function __t(key, params) {
  var val = __localeData[key];
  if (!val) return key;
  if (params) {
    for (var k in params) {
      if (params.hasOwnProperty(k)) {
        val = val.replace(new RegExp('\\{' + k + '\\}', 'g'), String(params[k]));
      }
    }
  }
  return val;
}
