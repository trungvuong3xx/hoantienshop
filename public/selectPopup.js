/* App-owned choice dialogs; original selects remain the form's source of truth. */
(() => {
  const dialog = document.createElement('dialog');
  dialog.className = 'app-choice-dialog';
  dialog.setAttribute('aria-labelledby', 'appChoiceTitle');
  dialog.innerHTML = '<header><h2 id="appChoiceTitle"></h2><button type="button" aria-label="Đóng">×</button></header><input class="app-choice-search" type="search" placeholder="Tìm lựa chọn..." aria-label="Tìm lựa chọn"><div class="app-choice-list"></div>';
  document.body.append(dialog);
  const title = dialog.querySelector('h2');
  const search = dialog.querySelector('input');
  const list = dialog.querySelector('.app-choice-list');
  const controls = new Map();
  let active = null;
  const label = select => select.labels?.[0]?.textContent.trim() || select.getAttribute('aria-label') || 'Chọn lựa chọn';
  const sync = select => {
    const button = controls.get(select);
    button.textContent = select.selectedOptions[0]?.textContent || 'Chọn lựa chọn';
    button.disabled = select.disabled;
    button.setAttribute('aria-label', `${label(select)}: ${button.textContent}`);
  };
  const render = () => {
    list.replaceChildren();
    if (!active) return;
    const query = search.value.trim().toLocaleLowerCase('vi');
    for (const option of active.options) {
      if (option.hidden || !option.textContent.toLocaleLowerCase('vi').includes(query)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'app-choice-option';
      button.textContent = option.textContent;
      button.disabled = option.disabled || option.parentElement.disabled;
      button.setAttribute('aria-pressed', String(option.selected));
      button.addEventListener('click', () => {
        const select = active;
        if (!select || select.disabled) return;
        const changed = select.selectedIndex !== option.index;
        select.selectedIndex = option.index;
        if (changed) {
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        dialog.close();
      });
      list.append(button);
    }
    if (!list.childElementCount) list.textContent = 'Không tìm thấy lựa chọn phù hợp.';
  };
  dialog.querySelector('header button').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('keydown', event => {
    event.stopPropagation(); // Do not close or trap focus in the parent app modal.
    if (event.key === 'Escape') { event.preventDefault(); dialog.close(); }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const options = [...list.querySelectorAll('button:not(:disabled)')];
      const index = options.indexOf(document.activeElement);
      options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
    }
  });
  dialog.addEventListener('close', () => {
    const button = controls.get(active);
    button?.setAttribute('aria-expanded', 'false');
    active = null;
    button?.focus();
  });
  search.addEventListener('input', render);
  document.querySelectorAll('select').forEach(select => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'app-choice-trigger';
    button.id = `${select.id}Choice`;
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    controls.set(select, button);
    select.after(button);
    select.hidden = true;
    select.tabIndex = -1;
    // Keep UI in sync with existing programmatic assignments and form resets.
    for (const property of ['value', 'selectedIndex']) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, property);
      Object.defineProperty(select, property, {
        configurable: true,
        get() { return descriptor.get.call(this); },
        set(value) { descriptor.set.call(this, value); sync(this); }
      });
    }
    select.addEventListener('change', () => sync(select));
    new MutationObserver(() => { sync(select); if (active === select) render(); })
      .observe(select, { subtree: true, childList: true, characterData: true, attributes: true });
    select.form?.addEventListener('reset', () => setTimeout(() => sync(select), 0));
    for (const item of select.labels || []) item.addEventListener('click', event => { event.preventDefault(); button.focus(); });
    button.addEventListener('click', () => {
      active = select;
      title.textContent = label(select);
      search.value = '';
      search.hidden = select.options.length < 8;
      render();
      button.setAttribute('aria-expanded', 'true');
      dialog.showModal();
      (search.hidden ? list.querySelector('[aria-pressed="true"]:not(:disabled)') || list.querySelector('button:not(:disabled)') : search)?.focus();
    });
    sync(select);
  });
  // Replace browser form-validation bubbles with the app's feedback.
  document.addEventListener('invalid', event => {
    event.preventDefault();
    const control = event.target;
    const focusTarget = controls.get(control) || control;
    if (!document.querySelector('.app-invalid-message')) {
      const message = document.createElement('p');
      message.className = 'app-invalid-message';
      message.setAttribute('role', 'alert');
      message.textContent = control.validationMessage;
      focusTarget.after(message);
      focusTarget.focus();
      const clear = () => message.remove();
      control.addEventListener('input', clear, { once: true });
      control.addEventListener('change', clear, { once: true });
      setTimeout(clear, 6000);
    }
  }, true);
})();
