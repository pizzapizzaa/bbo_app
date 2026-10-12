import { MAX_ADDON_QUANTITY } from '../../lib/pricing';

export function selectedAddonNames(root: HTMLElement, selector: string): string[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>(`${selector}:checked`)).flatMap((checkbox) =>
    Array.from({ length: Number(checkbox.dataset.quantity || 1) }, () => checkbox.dataset.name!),
  );
}

export function initAddonQuantities(root: HTMLElement, selector: string, onChange: () => void) {
  root.querySelectorAll<HTMLInputElement>(`${selector}[data-quantity]`).forEach((checkbox) => {
    const row = checkbox.closest<HTMLElement>('[data-addon-item]')!;
    const controls = row.querySelector<HTMLElement>('[data-addon-quantity-controls]')!;
    const input = row.querySelector<HTMLInputElement>('[data-addon-quantity-input]')!;
    const decrease = row.querySelector<HTMLButtonElement>('[data-addon-decrease]')!;
    const increase = row.querySelector<HTMLButtonElement>('[data-addon-increase]')!;
    function sync() {
      const quantity = Math.max(1, Math.min(MAX_ADDON_QUANTITY, Math.floor(Number(checkbox.dataset.quantity) || 1)));
      checkbox.dataset.quantity = String(quantity);
      input.value = String(quantity);
      input.disabled = !checkbox.checked;
      decrease.disabled = quantity <= 1;
      increase.disabled = quantity >= MAX_ADDON_QUANTITY;
      controls.classList.toggle('hidden', !checkbox.checked);
    }
    checkbox.addEventListener('change', () => { sync(); onChange(); });
    input.addEventListener('input', () => {
      if (!input.checkValidity()) return;
      checkbox.dataset.quantity = input.value;
      sync();
      onChange();
    });
    for (const [button, delta] of [[decrease, -1], [increase, 1]] as const) {
      button.addEventListener('click', () => {
        checkbox.dataset.quantity = String(Number(checkbox.dataset.quantity) + delta);
        sync();
        onChange();
      });
    }
    sync();
  });
}