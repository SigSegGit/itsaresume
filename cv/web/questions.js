// 2.22c: the owner answers the questions of every run (local host only).
// Text goes in through textContent; the server checks every answer
// (src/answers.js addAnswer) and the page only shows its refusal.

const token = document.querySelector('meta[name="csrf-token"]').content;

function element(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === 'text') node.textContent = value;
    else node.setAttribute(name, value);
  }
  node.append(...children.filter(Boolean));
  return node;
}

const LEVEL_LABELS = { expert: 'expert', proficient: 'confirmé', working: 'opérationnel', lab: 'en lab', notions: 'notions' };

function card(question, { levels, groups }) {
  const name = element('input', { type: 'text', value: question.asked, 'aria-label': 'Nom de la compétence' });
  const level = element('select', { 'aria-label': 'Niveau' }, ...levels.map((id) => element('option', { value: id, text: LEVEL_LABELS[id] ?? id })));
  level.value = 'working';
  const group = element('select', { 'aria-label': 'Groupe' }, ...groups.map((g) => element('option', { value: g.id, text: g.label ?? g.id })));
  const said = element('textarea', { rows: '2', placeholder: 'Où, quand, quoi — une phrase à toi', 'aria-label': 'Ta phrase' });
  const status = element('p', { class: 'status' });
  const yesFields = element('div', { class: 'yes-fields' }, name, level, group, said);
  const send = async (answer) => {
    const body = answer === 'yes'
      ? { id: question.id, asked: question.asked, answer, name: name.value, level: level.value, group: group.value, said: said.value }
      : { id: question.id, asked: question.asked, answer };
    const response = await fetch('/api/answers', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      status.textContent = `Refusé : ${result.error ?? response.status}`;
      return;
    }
    status.textContent = answer === 'yes' ? 'Ajouté au profil.' : 'Noté : la question ne reviendra pas.';
    for (const control of item.querySelectorAll('button, input, select, textarea')) control.disabled = true;
  };
  const yes = element('button', { type: 'button', text: 'Oui, enregistrer' });
  const no = element('button', { type: 'button', text: 'Non' });
  yes.addEventListener('click', () => send('yes'));
  no.addEventListener('click', () => send('no'));
  const item = element('li', {},
    element('strong', { text: question.asked }),
    element('span', { class: 'meta', text: ` — ${question.offers} offre(s)${question.must ? `, exigée par ${question.must}` : ''}` }),
    yesFields, element('div', { class: 'actions' }, yes, no), status);
  return item;
}

async function start() {
  const list = document.getElementById('questions');
  const notice = document.getElementById('notice');
  const job = new URLSearchParams(location.search).get('job');
  const response = await fetch(job ? `/api/questions?job=${encodeURIComponent(job)}` : '/api/questions');
  if (!response.ok) {
    notice.textContent = 'Les questions ne sont disponibles que sur la page locale.';
    notice.hidden = false;
    return;
  }
  const data = await response.json();
  if (!data.questions.length) {
    notice.textContent = 'Aucune question : le profil couvre ce que les offres demandent.';
    notice.hidden = false;
  }
  list.replaceChildren(...data.questions.map((question) => card(question, data)));
}

start();
