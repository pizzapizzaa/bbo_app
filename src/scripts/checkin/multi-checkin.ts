import { ADDONS, MANUAL_DISCOUNTS, checkinTypePrice, computeCheckinAmount, type ReferralTerms } from '../../lib/pricing';
import { gymToday, isValidDate, isValidTime, MAX_NAME, MAX_TEXT } from '../../lib/validate';
import { startCustomerRefresh } from '../customers/refresh';
import { initAddonQuantities, selectedAddonNames } from './addon-quantities';

export interface Customer {
	_id: string;
	_created_at?: string;
	_registration_source?: string;
	'Full Name': string;
	_membership_type?: string;
	_membership_end_date?: string;
	_is_punch_card_holder?: boolean;
	_punches_remaining?: number;
	_pt_punches_remaining?: number;
}

function foldedName(name: string) {
	return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase();
}

export function customerGroups(customers: Customer[], query = '', today = gymToday()) {
	const terms = foldedName(query.trim()).split(/\s+/).filter(Boolean);
	const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
	const newlyRegistered: Customer[] = [];
	const others: Customer[] = [];
	for (const customer of customers) {
		const words = foldedName(customer['Full Name']).split(/\s+/);
		if (!terms.every((term) => words.some((word) => word.startsWith(term)))) continue;
		const created = customer._created_at ? new Date(customer._created_at) : null;
		const isNew = customer._registration_source === 'self' && created && Number.isFinite(created.getTime()) && formatter.format(created) === today;
		(isNew ? newlyRegistered : others).push(customer);
	}
	newlyRegistered.sort((first, second) => Date.parse(second._created_at!) - Date.parse(first._created_at!) || first._id.localeCompare(second._id));
	others.sort((first, second) => Number(!foldedName(first['Full Name']).startsWith(foldedName(query.trim()))) - Number(!foldedName(second['Full Name']).startsWith(foldedName(query.trim()))) || first['Full Name'].localeCompare(second['Full Name']));
	return { newlyRegistered, others };
}

type SaveState = 'draft' | 'saved' | 'uncertain';
interface Referral extends ReferralTerms { code: string; owner_name?: string; label?: string; kind?: string }
interface Card {
	key: string;
	customer: Customer;
	root: HTMLElement;
	fields: HTMLFieldSetElement;
	state: SaveState;
	referral: Referral | null;
	referralVersion: number;
	timer?: ReturnType<typeof setTimeout>;
	autoAmount: number;
	overridden: boolean;
	manualPayment: boolean;
}
interface Payload {
	customer_name: string;
	date: string;
	time: string;
	payment_method: string;
	checkin_type: string;
	addons: string[];
	discount: string;
	referral_code: string;
	notes: string;
	amount?: number;
	amount_override?: boolean;
	punch_card_holder_id?: string;
	punch_card_holder_name?: string;
	pt_punch_holder_id?: string;
	pt_punch_holder_name?: string;
}

export function punchDemandError(payloads: Pick<Payload, 'punch_card_holder_id' | 'pt_punch_holder_id'>[], customers: Customer[]): string | null {
	for (const [idField, balanceField, label] of [
		['punch_card_holder_id', '_punches_remaining', 'punches'],
		['pt_punch_holder_id', '_pt_punches_remaining', 'PT punches'],
	] as const) {
		const demand = new Map<string, number>();
		for (const payload of payloads) {
			const holder = payload[idField];
			if (holder) demand.set(holder, (demand.get(holder) ?? 0) + 1);
		}
		for (const [id, required] of demand) {
			const customer = customers.find((entry) => entry._id === id);
			const available = customer?.[balanceField] ?? 0;
			if (required > available) return `${customer?.['Full Name'] ?? 'Selected holder'} has ${available} ${label} left; these check-ins need ${required}.`;
		}
	}
	return null;
}

function initMultiCheckin() {
	const byId = <ElementType extends HTMLElement>(id: string) => document.getElementById(id) as ElementType;
	const form = byId<HTMLFormElement>('multi-checkin-form');
	if (!form) return;
	const legacy = byId<HTMLFormElement>('checkin-form');
	const templates = Array.from(legacy.querySelectorAll<HTMLElement>('[data-checkin-details]')).map((section) => section.cloneNode(true) as HTMLElement);
	const search = byId<HTMLInputElement>('multi-customer-search');
	const panel = byId<HTMLElement>('multi-customer-panel');
	const results = byId<HTMLElement>('multi-customer-results');
	const date = byId<HTMLInputElement>('multi-date');
	const time = byId<HTMLInputElement>('multi-time');
	const submit = byId<HTMLButtonElement>('multi-submit');
	const fields = byId<HTMLFieldSetElement>('multi-checkin-fields');
	const cards = new Map<string, Card>();
	const api = window as unknown as {
		apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
		allCustomers: Customer[];
		buildCustomerDatalist: () => Promise<boolean>;
		loadCheckinsForRange: (from: string, to: string) => void;
		activeFrom: string;
		activeTo: string;
		formatDateLabel: (date: string) => string;
	};
	let customers: Customer[] = api.allCustomers ?? [];
	let sequence = 0;
	let busy = false;
	let visibleLimit = 50;
	const refresh = startCustomerRefresh(() => busy ? Promise.resolve(false) : api.buildCustomerDatalist());
	const now = new Date();
	date.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
	time.value = now.toTimeString().slice(0, 5);
	const formatAmount = (amount: number) => `${amount.toLocaleString('en-US')} VND`;
	const control = <ElementType extends HTMLElement>(card: Card, id: string) => card.root.querySelector(`[data-field="${id}"]`) as ElementType;
	const value = (card: Card, id: string) => control<HTMLInputElement>(card, id).value;
	const discount = (card: Card) => card.root.querySelector<HTMLInputElement>('.batch-discount:checked')?.value ?? '';
	const addons = (card: Card) => selectedAddonNames(card.root, '.batch-addon');
	const quote = (card: Card, discountId = discount(card)) => computeCheckinAmount({ date: date.value, checkin_type: value(card, 'f-checkin-type'), payment_method: value(card, 'f-payment'), addons: addons(card), discount: discountId, referral: card.referral });

	function summary() {
		const pending = Array.from(cards.values()).filter((card) => card.state === 'draft');
		const total = Array.from(cards.values()).reduce((sum, card) => sum + (Number(value(card, 'f-amount')) || 0), 0);
		byId('multi-total').textContent = formatAmount(total);
		byId('multi-picker-count').textContent = `${cards.size} selected`;
		byId('multi-customer-status').textContent = `${cards.size} selected`;
		byId('multi-empty').classList.toggle('hidden', cards.size > 0);
		submit.textContent = busy ? 'Recording...' : !pending.length ? 'Record Check-ins' : pending.length === 1 ? 'Record 1 Check-in' : `Record ${pending.length} Check-ins`;
		submit.disabled = busy || !pending.length;
	}

	function reprice(card: Card) {
		if (card.state !== 'draft') return;
		const price = quote(card);
		card.autoAmount = price.amount;
		const amount = control<HTMLInputElement>(card, 'f-amount');
		if (!card.overridden) amount.value = String(price.amount);
		const note = control(card, 'amount-note');
		note.classList.toggle('hidden', !card.overridden);
		note.textContent = `Manual amount - price list: ${formatAmount(price.amount)}.`;
		const banner = control(card, 'promo-banner');
		const promoParts: string[] = [];
		if (price.promo_pct) promoParts.push(price.promo_overridden ? `Automatic promotion would charge ${formatAmount(quote(card, '').amount)}; selected discount charges ${formatAmount(price.amount)}.` : `${price.promo_pct}% off applied automatically.`);
		if (price.promo_bonus_punches) promoParts.push(`+${price.promo_bonus_punches} bonus punches.`);
		banner.textContent = `${price.promo?.label ?? ''}: ${promoParts.join(' ')}`;
		banner.className = `text-xs rounded px-3 py-2 mt-1.5 bg-amber-900/40 text-amber-200 ${promoParts.length ? '' : 'hidden'}`;
		const overlap = control(card, 'referral-overlap');
		const best = MANUAL_DISCOUNTS.map((entry) => ({ ...entry, amount: quote(card, entry.id).amount })).sort((first, second) => first.amount - second.amount)[0];
		const warn = discount(card) === 'referral' && !!card.referral && best.amount < price.amount;
		overlap.classList.toggle('hidden', !warn);
		overlap.textContent = `${best.title} would charge ${formatAmount(best.amount)} instead.`;
		control<HTMLSelectElement>(card, 'f-checkin-type').querySelectorAll('option').forEach((option) => {
			if (option.value) option.textContent = `${option.value} (${formatAmount(checkinTypePrice(option.value, date.value))})`;
		});
		summary();
	}

	function paymentRows(card: Card) {
		for (const [method, row, field] of [['Punch Card', 'punch-from-row', 'f-punch-from'], ['PT Punch', 'pt-punch-from-row', 'f-pt-punch-from']]) {
			const selected = value(card, 'f-payment') === method;
			control(card, row).classList.toggle('hidden', !selected);
			if (!selected) control<HTMLSelectElement>(card, field).value = '';
		}
	}

	function holderOptions(card: Card) {
		for (const [id, balance] of [['f-punch-from', '_punches_remaining'], ['f-pt-punch-from', '_pt_punches_remaining']] as const) {
			const select = control<HTMLSelectElement>(card, id);
			const previous = select.value;
			select.replaceChildren(new Option('Select holder', ''));
			customers.filter((customer) => (customer[balance] ?? 0) > 0).forEach((customer) => select.add(new Option(`${customer['Full Name']} (${customer[balance]} left)`, customer._id)));
			if (previous && !Array.from(select.options).some((option) => option.value === previous)) {
				const holder = customers.find((customer) => customer._id === previous);
				select.add(new Option(`${holder?.['Full Name'] ?? 'Holder'} (0 left)`, previous));
			}
			select.value = previous;
			select.dispatchEvent(new Event('change'));
		}
	}

	function initHolderPicker(card: Card, id: string) {
		const select = control<HTMLSelectElement>(card, id);
		const toggle = control<HTMLButtonElement>(card, `${id}-toggle`);
		const panel = control(card, `${id}-panel`);
		const search = control<HTMLInputElement>(card, `${id}-search`);
		const results = control(card, `${id}-results`);
		const text = control(card, `${id}-text`);
		function close() {
			panel.classList.add('hidden');
			toggle.setAttribute('aria-expanded', 'false');
			search.setAttribute('aria-expanded', 'false');
		}
		function render() {
			results.replaceChildren();
			const terms = search.value.toLocaleLowerCase().split(/\s+/).filter(Boolean);
			const options = Array.from(select.options).filter((option) => option.value && terms.every((term) => option.text.toLocaleLowerCase().includes(term)));
			for (const option of options) {
				const button = document.createElement('button');
				button.type = 'button';
				button.className = 'w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 break-words';
				button.textContent = option.text;
				button.setAttribute('role', 'option');
				button.setAttribute('aria-selected', String(option.value === select.value));
				button.addEventListener('click', () => { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); close(); toggle.focus(); });
				results.append(button);
			}
			control(card, `${id}-empty`).classList.toggle('hidden', options.length > 0);
		}
		toggle.addEventListener('click', () => {
			if (!panel.classList.contains('hidden')) { close(); return; }
			search.value = '';
			render();
			panel.classList.remove('hidden');
			toggle.setAttribute('aria-expanded', 'true');
			search.setAttribute('aria-expanded', 'true');
			search.focus();
		});
		search.addEventListener('input', render);
		control(card, `${id}-picker`).addEventListener('keydown', (event) => {
			if (event.key === 'Escape') { event.stopPropagation(); close(); toggle.focus(); }
			if (event.key === 'Enter' && event.target === search) { event.preventDefault(); results.querySelector<HTMLButtonElement>('button')?.click(); }
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				const choices = Array.from(results.querySelectorAll<HTMLButtonElement>('button'));
				const index = choices.indexOf(document.activeElement as HTMLButtonElement);
				choices[Math.max(0, Math.min(choices.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
			}
		});
		control(card, `${id}-picker`).addEventListener('focusout', (event) => {
			if (!control(card, `${id}-picker`).contains(event.relatedTarget as Node)) close();
		});
		select.addEventListener('change', () => { text.textContent = select.selectedOptions[0]?.text ?? 'Select holder'; render(); });
	}

	function defaultPayment(card: Card) {
		if (card.manualPayment || card.state !== 'draft') return;
		const customer = customers.find((entry) => entry._id === card.customer._id) ?? card.customer;
		const membership = customer._membership_type && customer._membership_end_date && customer._membership_end_date >= date.value;
		control<HTMLSelectElement>(card, 'f-payment').value = membership ? 'Valid Membership' : customer._is_punch_card_holder && (customer._punches_remaining ?? 0) > 0 ? 'Punch Card' : '';
		paymentRows(card);
		if (value(card, 'f-payment') === 'Punch Card') control<HTMLSelectElement>(card, 'f-punch-from').value = customer._id;
		for (const id of ['f-punch-from', 'f-pt-punch-from']) control(card, id).dispatchEvent(new Event('change'));
	}

	async function verifyReferral(card: Card) {
		const version = ++card.referralVersion;
		const code = value(card, 'f-referral-code').trim().toUpperCase();
		card.referral = null;
		const status = control(card, 'referral-status');
		status.textContent = code ? 'Checking...' : 'Enter a referral or promo code.';
		reprice(card);
		if (!code) return;
		try {
			const response = await api.apiFetch(`/api/referral?code=${encodeURIComponent(code)}&customer=${encodeURIComponent(card.customer['Full Name'])}`);
			const data = await response.json();
			if (version !== card.referralVersion || !cards.has(card.key)) return;
			if (response.ok && data.valid) {
				card.referral = { ...data, code };
				status.textContent = `${data.label || data.owner_name || 'Promo'}: ${data.discount_pct}% off${data.rental_discount_pct ? `; ${data.rental_discount_pct}% off rentals` : ''}.`;
			} else status.textContent = data.error || 'Code not found.';
		} catch {
			if (version !== card.referralVersion) return;
			status.textContent = 'Could not verify the code. Try again.';
		}
		reprice(card);
	}

	function removeCard(card: Card) {
		if (busy) return;
		if (card.state === 'draft' && !confirm(`Remove ${card.customer['Full Name']} and discard their check-in details?`)) return;
		clearTimeout(card.timer);
		card.referralVersion++;
		cards.delete(card.key);
		card.root.remove();
		renderResults();
		summary();
	}

	function addCard(customer: Customer, key = customer._id) {
		if (cards.has(key)) return;
		const root = document.createElement('article');
		root.className = 'border border-gray-600 rounded-lg bg-gray-800 p-4 space-y-4 min-w-0';
		const header = document.createElement('div');
		header.className = 'flex flex-wrap items-center justify-between gap-3';
		const heading = document.createElement('h3');
		heading.className = 'font-semibold text-white break-words min-w-0';
		heading.textContent = customer['Full Name'] === 'Other' ? 'Unregistered customer' : customer['Full Name'];
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'text-sm text-red-300 hover:text-red-200 border border-gray-600 rounded px-3 py-2 shrink-0';
		remove.textContent = 'Remove customer';
		remove.setAttribute('aria-label', `Remove customer ${heading.textContent}`);
		header.append(heading, remove);
		const cardFields = document.createElement('fieldset');
		cardFields.className = 'space-y-4 min-w-0';
		const card: Card = { key, customer, root, fields: cardFields, state: 'draft', referral: null, referralVersion: 0, autoAmount: 0, overridden: false, manualPayment: false };
		for (const template of templates) {
			const section = template.cloneNode(true) as HTMLElement;
			section.removeAttribute('data-checkin-details');
			section.querySelectorAll<HTMLElement>('[id]').forEach((element) => {
				const original = element.id;
				element.dataset.field = original;
				element.id = `${key}-${original}`;
			});
			section.querySelectorAll<HTMLElement>('[onclick]').forEach((element) => element.removeAttribute('onclick'));
			section.querySelectorAll<HTMLInputElement>('.addon-cb').forEach((element) => { element.classList.replace('addon-cb', 'batch-addon'); element.checked = false; });
			section.querySelectorAll<HTMLInputElement>('.discount-rb').forEach((element) => { element.classList.replace('discount-rb', 'batch-discount'); element.name = `${key}-discount`; element.checked = element.value === ''; });
			section.querySelectorAll<HTMLInputElement>('input:not([type="radio"]):not([type="checkbox"])').forEach((element) => { element.value = ''; });
			section.querySelectorAll<HTMLSelectElement>('select').forEach((element) => { element.value = ''; });
			cardFields.append(section);
		}
		root.append(header, cardFields);
		if (customer['Full Name'] === 'Other') {
			const label = document.createElement('label');
			label.className = 'block text-sm text-gray-300';
			label.textContent = 'Customer name for records';
			const name = document.createElement('input');
			name.dataset.field = 'other-name';
			name.className = 'block w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 mt-1 text-white';
			label.append(name);
			cardFields.prepend(label);
		}
		const error = document.createElement('p');
		error.dataset.field = 'error';
		error.className = 'text-sm text-red-400';
		error.setAttribute('role', 'alert');
		root.append(error);
		cards.set(key, card);
		byId('multi-cards').append(root);
		remove.addEventListener('click', () => removeCard(card));
		for (const [body, chevron] of [['addons-body', 'addons-chevron'], ['discount-body', 'discount-chevron']]) {
			const element = control(card, body);
			element.classList.add('hidden');
			element.previousElementSibling!.addEventListener('click', () => control(card, chevron).classList.toggle('rotate-180', !element.classList.toggle('hidden')));
		}
		cardFields.querySelectorAll<HTMLElement>('[aria-labelledby], [aria-controls]').forEach((element) => {
			for (const attribute of ['aria-labelledby', 'aria-controls']) {
				const original = element.getAttribute(attribute);
				if (original) element.setAttribute(attribute, original.split(' ').map((id) => `${key}-${id}`).join(' '));
			}
		});
		cardFields.querySelectorAll('label').forEach((label) => {
			const input = label.parentElement?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
			if (!label.querySelector('input') && input?.id) label.htmlFor = input.id;
		});
		for (const id of ['f-punch-from', 'f-pt-punch-from']) initHolderPicker(card, id);
			initAddonQuantities(card.root, '.batch-addon', () => reprice(card));
		cardFields.addEventListener('change', (event) => {
			const target = event.target as HTMLInputElement;
			if (target.dataset.field === 'f-payment') { card.manualPayment = true; paymentRows(card); }
			if (target.classList.contains('batch-discount')) {
				const isReferral = discount(card) === 'referral';
				control(card, 'referral-code-row').classList.toggle('hidden', !isReferral);
				card.referral = null;
				card.referralVersion++;
				clearTimeout(card.timer);
				if (isReferral) { control(card, 'f-referral-code').focus(); void verifyReferral(card); }
				else control<HTMLInputElement>(card, 'f-referral-code').value = '';
			}
			reprice(card);
		});
		control<HTMLInputElement>(card, 'f-amount').addEventListener('input', () => {
			card.overridden = value(card, 'f-amount') !== '' && Math.round(Number(value(card, 'f-amount'))) !== card.autoAmount;
			reprice(card);
		});
		control<HTMLInputElement>(card, 'f-referral-code').addEventListener('input', () => {
			const input = control<HTMLInputElement>(card, 'f-referral-code');
			input.value = input.value.toUpperCase();
			card.referral = null;
			card.referralVersion++;
			clearTimeout(card.timer);
			card.timer = setTimeout(() => void verifyReferral(card), 350);
			reprice(card);
		});
		card.root.querySelectorAll<HTMLInputElement>('[data-tier-of]').forEach((checkbox) => {
			const tiers = ADDONS.filter((addon) => addon.tier?.of === checkbox.dataset.tierOf);
			const stem = checkbox.dataset.field!.replace('addon-tier-', '');
			let index = 0;
			function syncTier() {
				checkbox.dataset.name = tiers[index].name;
				checkbox.dataset.price = String(tiers[index].price);
				control(card, `tier-price-${stem}`).textContent = formatAmount(tiers[index].price);
				control(card, `tier-label-${stem}`).textContent = tiers[index].tier!.label;
				control(card, `tier-qty-${stem}`).classList.toggle('hidden', !checkbox.checked);
				control<HTMLButtonElement>(card, `tier-dec-${stem}`).disabled = index === 0;
				control<HTMLButtonElement>(card, `tier-inc-${stem}`).disabled = index === tiers.length - 1;
				reprice(card);
			}
			checkbox.addEventListener('change', syncTier);
			for (const [suffix, delta] of [['dec', -1], ['inc', 1]] as const) control(card, `tier-${suffix}-${stem}`).addEventListener('click', () => { index = Math.max(0, Math.min(tiers.length - 1, index + delta)); syncTier(); });
			syncTier();
		});
		holderOptions(card);
		defaultPayment(card);
		reprice(card);
		summary();
	}

	function closePicker() { panel.classList.add('hidden'); search.setAttribute('aria-expanded', 'false'); }
	function renderResults() {
		const focusedId = (document.activeElement as HTMLElement)?.dataset.customerId;
		const focusedCommand = (document.activeElement as HTMLElement)?.dataset.customerCommand;
		const scrollTop = results.scrollTop;
		results.replaceChildren();
		const groups = customerGroups(customers, search.value);
		const matches = [...groups.newlyRegistered, ...groups.others];
		const focusedIndex = matches.findIndex((customer) => customer._id === focusedId);
		if (focusedIndex >= visibleLimit) visibleLimit = Math.ceil((focusedIndex + 1) / 50) * 50;
		let rendered = 0;
		for (const [title, group] of [['Newly Registered Customers', groups.newlyRegistered], ['All Other Customers', groups.others]] as const) {
			const visible = group.slice(0, Math.max(0, visibleLimit - rendered));
			if (!visible.length) continue;
			const heading = document.createElement('p');
			heading.className = 'px-3 py-2 text-xs font-semibold text-orange-300 border-b border-gray-700';
			heading.textContent = title;
			results.append(heading);
			for (const customer of visible) {
			const label = document.createElement('label');
			label.className = 'flex items-center gap-3 px-3 py-3 text-sm text-gray-200 hover:bg-gray-700 cursor-pointer';
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.dataset.customerId = customer._id;
			checkbox.className = 'accent-orange-500 w-4 h-4 shrink-0';
			checkbox.checked = cards.has(customer._id);
			checkbox.disabled = busy || (cards.get(customer._id)?.state !== undefined && cards.get(customer._id)?.state !== 'draft');
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) addCard(customer);
				else { const card = cards.get(customer._id); if (card) removeCard(card); checkbox.checked = cards.has(customer._id); }
				summary();
			});
			const text = document.createElement('span');
			text.className = 'break-words min-w-0';
			text.textContent = customer['Full Name'];
			label.append(checkbox, text);
			results.append(label);
			}
			rendered += visible.length;
		}
		if (!matches.length) { const empty = document.createElement('p'); empty.className = 'px-3 py-3 text-sm text-gray-400'; empty.textContent = 'No matching customers.'; results.append(empty); }
		if (rendered < matches.length) {
			const more = document.createElement('button');
			more.type = 'button';
			more.dataset.customerCommand = 'more';
			more.className = 'w-full text-left px-3 py-3 text-sm text-orange-300 hover:bg-gray-700';
			more.textContent = `Show more customers (${matches.length - rendered} remaining)`;
			more.addEventListener('click', () => { visibleLimit += 50; renderResults(); });
			results.append(more);
		}
		const other = document.createElement('button');
		other.type = 'button';
		other.dataset.customerCommand = 'other';
		other.className = 'w-full text-left px-3 py-3 border-t border-gray-600 text-sm text-gray-300 hover:bg-gray-700';
		other.textContent = 'Add unregistered customer';
		other.addEventListener('click', () => { const key = `other-${++sequence}`; addCard({ _id: key, 'Full Name': 'Other' }, key); summary(); });
		results.append(other);
		if (focusedId) Array.from(results.querySelectorAll<HTMLInputElement>('[data-customer-id]')).find((checkbox) => checkbox.dataset.customerId === focusedId)?.focus({ preventScroll: true });
		if (focusedCommand) Array.from(results.querySelectorAll<HTMLButtonElement>('[data-customer-command]')).find((button) => button.dataset.customerCommand === focusedCommand)?.focus({ preventScroll: true });
		results.scrollTop = scrollTop;
	}
	const openPicker = () => { renderResults(); panel.classList.remove('hidden'); search.setAttribute('aria-expanded', 'true'); void refresh.refreshIfStale(); };
	search.addEventListener('focus', openPicker);
	search.addEventListener('input', () => { visibleLimit = 50; results.scrollTop = 0; openPicker(); });
	byId('multi-customer-done').addEventListener('click', () => { closePicker(); search.focus(); closePicker(); });
	byId('multi-customer-picker').addEventListener('keydown', (event) => {
		if (event.key === 'Escape') { closePicker(); search.focus(); closePicker(); }
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (panel.classList.contains('hidden')) openPicker();
			const choices = Array.from(results.querySelectorAll<HTMLElement>('input:not(:disabled), button'));
			const index = choices.indexOf(document.activeElement as HTMLElement);
			choices[Math.max(0, Math.min(choices.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
		}
		if (event.key === 'Enter' && event.target === search) event.preventDefault();
	});
	document.addEventListener('click', (event) => { if (!byId('multi-customer-picker').contains(event.target as Node)) closePicker(); });
	document.addEventListener('checkin-customers', (event) => {
		customers = (event as CustomEvent<Customer[]>).detail;
		for (const card of cards.values()) if (card.state === 'draft' && !card.root.contains(document.activeElement)) holderOptions(card);
		renderResults();
		summary();
	});
	document.addEventListener('checkin-customers-error', () => { byId('multi-customer-status').textContent = 'Customer refresh failed. Retrying automatically.'; });
	date.addEventListener('change', () => { for (const card of cards.values()) { defaultPayment(card); reprice(card); } });

	function payload(card: Card): Payload {
		const method = value(card, 'f-payment');
		const holder = customers.find((customer) => customer._id === value(card, 'f-punch-from'));
		const ptHolder = customers.find((customer) => customer._id === value(card, 'f-pt-punch-from'));
		const notes = value(card, 'f-notes').trim();
		const otherName = card.customer['Full Name'] === 'Other' ? value(card, 'other-name').trim() : '';
		return {
			customer_name: card.customer['Full Name'], date: date.value, time: time.value, payment_method: method,
			checkin_type: value(card, 'f-checkin-type'), addons: addons(card), discount: discount(card),
			referral_code: discount(card) === 'referral' ? card.referral?.code ?? '' : '',
			notes: otherName ? `Unregistered: ${otherName}${notes ? ` | ${notes}` : ''}` : notes,
			amount: card.overridden ? Math.round(Number(value(card, 'f-amount'))) : undefined,
			amount_override: card.overridden || undefined,
			punch_card_holder_id: method === 'Punch Card' ? holder?._id : undefined,
			punch_card_holder_name: method === 'Punch Card' ? holder?.['Full Name'] : undefined,
			pt_punch_holder_id: method === 'PT Punch' ? ptHolder?._id : undefined,
			pt_punch_holder_name: method === 'PT Punch' ? ptHolder?.['Full Name'] : undefined,
		};
	}

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		if (busy) return;
		const pending = Array.from(cards.values()).filter((card) => card.state === 'draft');
		const error = byId('multi-error');
		error.classList.add('hidden');
		if (!pending.length) return;
		if (!isValidDate(date.value) || !isValidTime(time.value)) { error.textContent = 'Choose a valid date and time.'; error.classList.remove('hidden'); return; }
		let firstInvalid: Card | undefined;
		for (const card of pending) {
			const data = payload(card);
			let message = '';
			if (!data.payment_method) message = 'Choose a payment method.';
			else if (data.payment_method === 'Punch Card' && !data.punch_card_holder_id) message = 'Choose a punch card holder.';
			else if (data.payment_method === 'PT Punch' && !data.pt_punch_holder_id) message = 'Choose a PT punch holder.';
			else if (discount(card) === 'referral' && !card.referral) message = 'Enter and verify a valid referral or promo code.';
			else if (card.fields.querySelector('[data-addon-quantity-input]:enabled:invalid')) message = 'Enter a whole beverage quantity from 1 to 999.';
			else if (!Number.isFinite(Number(value(card, 'f-amount'))) || Number(value(card, 'f-amount')) < 0) message = 'Enter a valid non-negative amount.';
			else if (data.notes.length > MAX_TEXT || data.customer_name.length > MAX_NAME) message = 'Customer name or notes exceed the maximum length.';
			control(card, 'error').textContent = message;
			if (message && !firstInvalid) firstInvalid = card;
		}
		if (firstInvalid) { firstInvalid.root.scrollIntoView({ block: 'center', behavior: 'smooth' }); firstInvalid.fields.querySelector<HTMLElement>('select, input')?.focus(); return; }
		const demandError = punchDemandError(pending.map(payload), customers);
		if (demandError) { error.textContent = demandError; error.classList.remove('hidden'); return; }
		busy = true;
		fields.disabled = true;
		closePicker();
		summary();
		let saved = 0;
		try {
			for (const card of pending) {
				byId('multi-save-status').textContent = `Recording ${card.customer['Full Name']}...`;
				let response: Response;
				let data;
				try {
					response = await api.apiFetch('/api/checkins', { method: 'POST', body: JSON.stringify(payload(card)) });
					data = await response.json();
				} catch {
					card.state = 'uncertain';
					card.fields.disabled = true;
					control(card, 'error').textContent = 'Save outcome unknown. Check the daily tracker before adding this customer again.';
					break;
				}
				if (!response.ok || data.error) {
					control(card, 'error').textContent = data.error || 'Could not save this check-in.';
					  if (response.status >= 500 && !data.not_saved) { card.state = 'uncertain'; card.fields.disabled = true; break; }
					continue;
				}
				card.state = 'saved';
				card.fields.disabled = true;
				card.overridden = false;
				control<HTMLInputElement>(card, 'f-amount').value = String(data.price?.charged ?? data.checkin?.amount ?? card.autoAmount);
				control(card, 'error').className = 'text-sm text-green-400';
				control(card, 'error').textContent = 'Check-in recorded.';
				saved++;
			}
		} finally {
			api.activeFrom = date.value;
			api.activeTo = date.value;
			byId<HTMLInputElement>('view-from').value = date.value;
			byId<HTMLInputElement>('view-to').value = date.value;
			byId('table-date-label').textContent = api.formatDateLabel(date.value);
			api.loadCheckinsForRange(date.value, date.value);
			await api.buildCustomerDatalist();
			busy = false;
			fields.disabled = false;
			const remaining = Array.from(cards.values()).filter((card) => card.state === 'draft').length;
			byId('multi-save-status').textContent = `${saved} check-in${saved === 1 ? '' : 's'} recorded.${remaining ? ` ${remaining} remaining; review errors before retrying.` : ''}`;
			Array.from(cards.values()).filter((card) => card.state === 'saved').forEach(removeCard);
			if (!cards.size) search.value = '';
			renderResults();
			summary();
		}
	});
	summary();
}

if (typeof document !== 'undefined') initMultiCheckin();