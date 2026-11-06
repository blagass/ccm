/* LeadFlow embeddable form renderer.
 * Usage on any website:
 *   <div data-leadflow-form="FORM_PUBLIC_ID"></div>
 *   <script src="https://YOUR-LEADFLOW-HOST/embed.js" async></script>
 */
(function () {
  var script = document.currentScript || document.querySelector('script[src*="embed.js"]');
  var ORIGIN = script ? new URL(script.src, location.href).origin : location.origin;

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'text') e.textContent = attrs[k];
      else if (attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  function utms() {
    var out = {}, p = new URLSearchParams(location.search);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(function (k) {
      var v = p.get(k);
      try { if (v) sessionStorage.setItem('lf_' + k, v); else v = sessionStorage.getItem('lf_' + k); } catch (e) {}
      if (v) out[k] = v;
    });
    return out;
  }

  function injectStyles() {
    if (document.getElementById('lf-styles')) return;
    var css = '.lf-form{font-family:inherit;display:grid;gap:14px}.lf-field label{display:block;font-size:14px;font-weight:600;margin-bottom:6px}' +
      '.lf-field input:not([type=checkbox]),.lf-field select,.lf-field textarea{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d0d5dd;border-radius:8px;font:inherit;font-size:15px;background:#fff}' +
      '.lf-field textarea{min-height:100px}.lf-check{display:flex;gap:8px;align-items:center;font-size:14px}.lf-err{color:#d92d20;font-size:13px;margin-top:4px}' +
      '.lf-btn{padding:11px 18px;border:0;border-radius:8px;color:#fff;font:inherit;font-weight:600;cursor:pointer}.lf-btn[disabled]{opacity:.6}' +
      '.lf-success{padding:16px;border-radius:8px;background:#ecfdf3;color:#05603a}.lf-hp{position:absolute;left:-9999px}';
    document.head.appendChild(el('style', { id: 'lf-styles', text: css }));
  }

  function render(container, def) {
    var fieldEls = {};
    var form = el('form', { class: 'lf-form', novalidate: true });
    def.fields.forEach(function (f) {
      var id = 'lf-' + def.id + '-' + f.name, input;
      if (f.type === 'hidden') { form.appendChild(el('input', { type: 'hidden', name: f.name, value: f.value || '' })); return; }
      if (f.type === 'textarea') input = el('textarea', { id: id, name: f.name, placeholder: f.placeholder, required: f.required });
      else if (f.type === 'select') {
        input = el('select', { id: id, name: f.name, required: f.required },
          [el('option', { value: '', text: f.placeholder || 'Select…' })].concat(f.options.map(function (o) { return el('option', { value: o, text: o }); })));
      } else input = el('input', { id: id, name: f.name, type: f.type, placeholder: f.placeholder, required: f.required });
      var err = el('div', { class: 'lf-err' });
      var wrap;
      if (f.type === 'checkbox') wrap = el('div', { class: 'lf-field' }, [el('label', { class: 'lf-check', for: id }, [input, el('span', { text: f.label + (f.required ? ' *' : '') })]), err]);
      else wrap = el('div', { class: 'lf-field' }, [el('label', { for: id, text: f.label + (f.required ? ' *' : '') }), input, err]);
      fieldEls[f.name] = err;
      form.appendChild(wrap);
    });
    // Honeypot field for spam bots
    form.appendChild(el('div', { class: 'lf-hp', 'aria-hidden': 'true' }, [el('input', { name: '_hp', tabindex: '-1', autocomplete: 'off' })]));
    var btn = el('button', { type: 'submit', class: 'lf-btn', text: def.settings.submit_label || 'Submit', style: 'background:' + (def.settings.accent_color || '#4f46e5') });
    form.appendChild(btn);
    var general = el('div', { class: 'lf-err' });
    form.appendChild(general);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = {};
      Array.prototype.forEach.call(form.elements, function (i) {
        if (!i.name) return;
        data[i.name] = i.type === 'checkbox' ? i.checked : i.value;
      });
      data._meta = Object.assign({ page_url: location.href, referrer: document.referrer }, utms());
      for (var k in fieldEls) fieldEls[k].textContent = '';
      general.textContent = '';
      btn.disabled = true;
      fetch(ORIGIN + '/api/public/forms/' + def.id + '/submit', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data)
      }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
        .then(function (res) {
          btn.disabled = false;
          if (res.body.ok) {
            if (res.body.redirect_url) { location.href = res.body.redirect_url; return; }
            container.innerHTML = '';
            container.appendChild(el('div', { class: 'lf-success', text: res.body.message }));
            container.dispatchEvent(new CustomEvent('leadflow:submitted', { bubbles: true, detail: { form: def.id } }));
          } else if (res.body.errors) {
            for (var k in res.body.errors) (fieldEls[k] || general).textContent = res.body.errors[k];
          } else general.textContent = res.body.error || 'Something went wrong';
        })
        .catch(function () { btn.disabled = false; general.textContent = 'Network error, please try again.'; });
    });
    container.innerHTML = '';
    container.appendChild(form);
  }

  function init() {
    injectStyles();
    utms();
    document.querySelectorAll('[data-leadflow-form]:not([data-lf-ready])').forEach(function (c) {
      c.setAttribute('data-lf-ready', '1');
      fetch(ORIGIN + '/api/public/forms/' + encodeURIComponent(c.getAttribute('data-leadflow-form')))
        .then(function (r) { if (!r.ok) throw new Error('not found'); return r.json(); })
        .then(function (def) { render(c, def); })
        .catch(function () { c.textContent = 'Form unavailable.'; });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
