/*
 * Catanho — distribuição de catanhos para atletas
 * Autenticação: Firebase Authentication (e-mail e senha)
 * Banco de dados: Cloud Firestore
 *
 * Nenhuma senha fica neste código nem no banco. As permissões, os limites e a
 * baixa no estoque são garantidos pelas regras do Firestore (firestore.rules),
 * não apenas por esta tela.
 */
(async function () {
  'use strict';

  const SDK = 'https://www.gstatic.com/firebasejs/12.19.0/';
  const MAX_ITENS_POR_SOLICITACAO = 6; // mesmo valor das regras do Firestore
  const app = document.getElementById('app');
  const $ = id => document.getElementById(id);
  const CARREGANDO = '<div class="carregando">Carregando…</div>';

  const MODALIDADES_INICIAIS = [
    'Futebol', 'Futsal', 'Vôlei', 'Basquete', 'Handebol', 'Atletismo',
    'Natação', 'Judô', 'Tênis de Mesa', 'Xadrez', 'Ciclismo'
  ];
  const UNIDADES = ['un', 'pct', 'cx', 'kg', 'g', 'L', 'ml'];

  /* ---------- Configuração ---------- */
  const cfg = window.FIREBASE_CONFIG || {};
  if (!cfg.apiKey || cfg.apiKey === 'COLE_AQUI') {
    app.innerHTML = `<div class="login-wrap"><div class="card login">
      <span class="marca">Configuração pendente</span>
      <h1>Firebase não configurado</h1>
      <p class="muted">Preencha o arquivo <strong>js/firebase-config.js</strong> com os dados do seu projeto Firebase.</p>
    </div></div>`;
    return;
  }

  let fbApp, fbAuth, fbStore;
  try {
    [fbApp, fbAuth, fbStore] = await Promise.all([
      import(SDK + 'firebase-app.js'),
      import(SDK + 'firebase-auth.js'),
      import(SDK + 'firebase-firestore.js')
    ]);
  } catch (e) {
    app.innerHTML = `<div class="login-wrap"><div class="card login">
      <h1>Sem conexão</h1>
      <p class="muted">Não foi possível carregar o sistema. Verifique a internet e recarregue a página.</p>
    </div></div>`;
    return;
  }

  const { initializeApp, deleteApp } = fbApp;
  const {
    getAuth, initializeAuth, inMemoryPersistence, signInWithEmailAndPassword, signOut,
    onAuthStateChanged, createUserWithEmailAndPassword, sendPasswordResetEmail
  } = fbAuth;
  const {
    getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc,
    query, where, serverTimestamp, writeBatch, increment
  } = fbStore;

  const firebaseApp = initializeApp(cfg);
  const auth = getAuth(firebaseApp);
  const db = getFirestore(firebaseApp);

  /* ---------- Estado ---------- */
  let perfil = null;        // { uid, nome, email, perfil, modalidadeId }
  let mensagemLogin = '';
  let dados = vazio();
  let filtroSolicitacoes = 'todas';
  // Quem está usando o painel de solicitações (Administrador ou Catanheiro).
  const CTX_ADMIN = { papel: 'admin', recarregar: msg => telaAdmin('solicitacoes', msg, true) };
  const CTX_CATANHEIRO = { papel: 'catanheiro', recarregar: msg => telaCatanheiro(msg) };
  let ctxSol = CTX_ADMIN;

  function vazio() {
    return { modalidades: [], eventos: [], usuarios: [], solicitacoes: [], itens: [], movimentos: [] };
  }

  /* ---------- Utilitários ---------- */
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtData(iso) {
    if (!iso) return '—';
    const [a, m, d] = iso.split('-');
    return `${d}/${m}/${a}`;
  }
  function fmtDataHora(ts) {
    if (!ts || !ts.toDate) return '—';
    const d = ts.toDate();
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  const ms = ts => (ts && ts.toMillis) ? ts.toMillis() : 0;
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const catanhos = n => plural(n, 'catanho', 'catanhos');

  function msgErro(e) {
    const c = (e && e.code) || '';
    if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email', 'auth/invalid-login-credentials'].includes(c))
      return 'E-mail ou senha inválidos.';
    if (c === 'auth/too-many-requests') return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
    if (c === 'auth/email-already-in-use') return 'Este e-mail já possui um acesso cadastrado.';
    if (c === 'auth/weak-password') return 'A senha deve ter pelo menos 6 caracteres.';
    if (c === 'auth/network-request-failed' || c === 'unavailable') return 'Sem conexão com a internet. Tente novamente.';
    if (c === 'permission-denied') return 'Você não tem permissão para realizar esta operação.';
    return 'Ocorreu um erro inesperado' + (c ? ` (${c})` : '') + '.';
  }
  async function comBotao(btn, fn) {
    btn.disabled = true;
    try { await fn(); } finally { if (btn.isConnected) btn.disabled = false; }
  }
  async function lista(nome) {
    const s = await getDocs(collection(db, nome));
    return s.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  async function listaConsulta(q) {
    const s = await getDocs(q);
    return s.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  // Quantidades: somente números inteiros.
  function paraInteiro(txt) {
    const t = String(txt ?? '').trim();
    if (t === '') return null;
    if (!/^\d+$/.test(t)) return NaN;
    return Number(t);
  }
  const fmtQtd = n => Number(n || 0).toLocaleString('pt-BR');
  const qtdUn = (n, un) => `${fmtQtd(n)} ${un || ''}`.trim();
  const editavel = n => n == null ? '' : String(n);
  const inteiro = txt => {
    const t = String(txt ?? '').trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isInteger(n) ? n : NaN;
  };

  const modalidade = id => dados.modalidades.find(m => m.id === id);
  const evento = id => dados.eventos.find(e => e.id === id);
  const item = id => dados.itens.find(i => i.id === id);
  // Fluxo: pendente -> recebido ("Pedido Recebido") -> fornecido ("Fornecido" + baixa no estoque).
  // "atendido" existe apenas em solicitações antigas (anteriores a este fluxo).
  const statusDe = s => ['recebido', 'fornecido', 'atendido'].includes(s.status) ? s.status : 'pendente';
  const grupoDe = s => ({ pendente: 'pendentes', recebido: 'recebidos', fornecido: 'fornecidos', atendido: 'fornecidos' })[statusDe(s)];
  const classeLinha = s => ({ pendente: 'linha-pendente', recebido: 'linha-recebida', fornecido: 'linha-atendida', atendido: 'linha-atendida' })[statusDe(s)];
  // Solicitações novas baixam o estoque no "Fornecido"; as antigas já baixaram ao serem criadas.
  const baixaNoFornecimento = s => s.baixaNoFornecimento === true;
  const estoqueBaixado = s => baixaNoFornecimento(s) ? statusDe(s) === 'fornecido' : true;
  const dataDaBaixa = s => baixaNoFornecimento(s) ? s.fornecidoEm : s.criadoEm;

  const nomeEvento = ev => ev ? `${ev.nome} (${fmtData(ev.data)})` : '—';
  const eventosOrdenados = () => dados.eventos.slice().sort((a, b) => (a.data || '').localeCompare(b.data || '') || a.nome.localeCompare(b.nome));
  const itensOrdenados = () => dados.itens.slice().sort((a, b) => a.nome.localeCompare(b.nome));
  const ordenarModalidades = l => l.slice().sort((a, b) => (a.ordem || 0) - (b.ordem || 0) || a.nome.localeCompare(b.nome));
  const itensDaSolicitacao = s => Object.entries(s.itens || {}).map(([id, v]) => ({ id, ...v })).sort((a, b) => a.nome.localeCompare(b.nome));

  function listaItensHtml(s) {
    const l = itensDaSolicitacao(s);
    if (!l.length) return '<span class="muted">—</span>';
    return `<ul class="lista-itens">${l.map(i => `<li>${esc(i.nome)}: <strong>${esc(qtdUn(i.quantidade, i.unidade))}</strong></li>`).join('')}</ul>`;
  }
  function seloStatus(s) {
    return {
      pendente: '<span class="status pendente">● Pendente</span>',
      recebido: '<span class="status recebido">◐ Pedido Recebido</span>',
      fornecido: '<span class="status atendido">✓ Fornecido</span>',
      atendido: '<span class="status atendido">✓ Atendido</span>'
    }[statusDe(s)];
  }
  function historicoStatus(s) {
    const linhas = [];
    if (s.recebidoEm) linhas.push(`Recebido: ${fmtDataHora(s.recebidoEm)} por ${esc(s.recebidoPorNome || '—')}`);
    if (s.fornecidoEm) linhas.push(`Fornecido: ${fmtDataHora(s.fornecidoEm)} por ${esc(s.fornecidoPorNome || '—')}`);
    if (s.atendidoEm) linhas.push(`Atendido: ${fmtDataHora(s.atendidoEm)} por ${esc(s.atendidoPorNome || '—')}`);
    return linhas.length ? `<div class="atendimento">${linhas.join('<br>')}</div>` : '';
  }

  async function sair(mensagem) {
    mensagemLogin = mensagem || '';
    dados = vazio();
    await signOut(auth);
  }

  /* ---------- Sessão ---------- */
  onAuthStateChanged(auth, async user => {
    if (!user) { perfil = null; return telaLogin(); }
    app.innerHTML = CARREGANDO;
    try {
      const s = await getDoc(doc(db, 'usuarios', user.uid));
      if (!s.exists()) return sair('Seu acesso ainda não foi configurado. Procure o Administrador.');
      perfil = { uid: user.uid, ...s.data() };
      if (perfil.perfil === 'admin') { filtroSolicitacoes = 'todas'; ctxSol = CTX_ADMIN; return telaAdmin('solicitacoes', '', true); }
      if (perfil.perfil === 'catanheiro') { filtroSolicitacoes = 'recebidos'; ctxSol = CTX_CATANHEIRO; return telaCatanheiro(); }
      if (perfil.perfil === 'responsavel' && perfil.modalidadeId) return telaResponsavel();
      return sair('Usuário sem modalidade vinculada. Procure o Administrador.');
    } catch (e) {
      return sair(msgErro(e));
    }
  });

  function cabecalho(sub, comAtualizar) {
    return `<header class="topo">
      <div><strong>Catanho</strong> <span class="sub">· ${esc(sub)}</span></div>
      <div class="topo-dir">
        <span>${esc(perfil.nome)}</span>
        ${comAtualizar ? '<button class="btn claro pequeno" id="btnAtualizar">Atualizar</button>' : ''}
        <button class="btn claro pequeno" id="btnSair">Sair</button>
      </div>
    </header>`;
  }
  function ligarSair() { $('btnSair').onclick = () => sair(); }

  function telaFalha(sub, e, tentarDeNovo) {
    app.innerHTML = cabecalho(sub) + `<main class="conteudo estreito"><section class="card">
      <h2>Não foi possível carregar os dados</h2>
      <div class="erro">${esc(msgErro(e))}</div>
      <button class="btn primario" id="btnTentar">Tentar novamente</button>
    </section></main>`;
    ligarSair();
    $('btnTentar').onclick = tentarDeNovo;
  }

  /* ---------- Login ---------- */
  function telaLogin() {
    const msg = mensagemLogin; mensagemLogin = '';
    app.innerHTML = `
    <div class="login-wrap">
      <form class="card login" id="fLogin" novalidate>
        <span class="marca">Catanho</span>
        <h1>Acesso ao sistema</h1>
        <p class="muted" style="margin-top:-.3rem;margin-bottom:1.2rem">Distribuição de catanhos para atletas</p>
        <label>Usuário/e-mail<input type="email" name="email" autocomplete="username" placeholder="seu@email.com"></label>
        <label>Senha<input type="password" name="senha" autocomplete="current-password"></label>
        <div class="erro" id="erroLogin">${esc(msg)}</div>
        <button class="btn primario" type="submit" id="btnEntrar">Entrar</button>
      </form>
    </div>`;
    $('fLogin').onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const email = String(f.get('email')).trim();
      const senha = String(f.get('senha'));
      if (!email || !senha) { $('erroLogin').textContent = 'Informe o usuário/e-mail e a senha.'; return; }
      comBotao($('btnEntrar'), async () => {
        try { await signInWithEmailAndPassword(auth, email, senha); }
        catch (err) { if ($('erroLogin')) $('erroLogin').textContent = msgErro(err); }
      });
    };
  }

  /* ================= Responsável ================= */
  async function telaResponsavel(mensagem) {
    app.innerHTML = CARREGANDO;
    let mod;
    try {
      const [mSnap, eventos, itens, solicitacoes] = await Promise.all([
        getDoc(doc(db, 'modalidades', perfil.modalidadeId)),
        listaConsulta(query(collection(db, 'eventos'), where('modalidadeId', '==', perfil.modalidadeId))),
        lista('itens'),
        listaConsulta(query(collection(db, 'solicitacoes'), where('modalidadeId', '==', perfil.modalidadeId)))
      ]);
      if (!mSnap.exists()) return sair('A modalidade vinculada ao seu acesso não foi encontrada. Procure o Administrador.');
      mod = { id: mSnap.id, ...mSnap.data() };
      dados = { ...vazio(), modalidades: [mod], eventos, itens, solicitacoes };
    } catch (e) {
      return telaFalha('Solicitação de catanhos', e, () => telaResponsavel());
    }

    const minhas = dados.solicitacoes.slice().sort((a, b) => ms(b.criadoEm) - ms(a.criadoEm));
    app.innerHTML = cabecalho('Solicitação de catanhos') + `
    <main class="conteudo estreito">
      ${mensagem ? `<div class="aviso">${esc(mensagem)}</div>` : ''}
      <section class="card" id="secSolicitacao"></section>
      <section class="card">
        <h2>Solicitações da modalidade</h2>
        ${minhas.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Registrada em</th><th>Evento</th><th>Retirada</th><th class="num">Catanhos</th><th>Itens</th><th>Status</th></tr></thead>
          <tbody>${minhas.map(s => `<tr class="${classeLinha(s)}">
            <td>${fmtDataHora(s.criadoEm)}</td>
            <td>${esc(nomeEvento(evento(s.eventoId)))}</td>
            <td>${esc(s.horarioRetirada || '—')}</td>
            <td class="num">${fmtQtd(s.quantidade)}</td>
            <td>${listaItensHtml(s)}</td>
            <td>${seloStatus(s)}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhuma solicitação registrada.</p>'}
      </section>
    </main>`;
    ligarSair();
    formularioSolicitacao(mod);
  }

  function msgLimiteModalidade(m) {
    return m.limite == null
      ? 'O limite de catanhos desta modalidade ainda não foi definido pelo Administrador.'
      : `Quantidade máxima permitida para esta modalidade: ${catanhos(m.limite)}.`;
  }

  // Validação usada no formulário e novamente antes de gravar (com dados atualizados).
  // Cada item marcado recebe a mesma quantidade de catanhos solicitada.
  // A baixa no estoque só ocorre quando o Administrador marca o pedido como "Fornecido".
  function validarSolicitacao(mod, d, catalogo) {
    const erros = [], itens = [];
    if (mod.limite == null || d.quantidade > mod.limite) erros.push(msgLimiteModalidade(mod));
    if (!d.itemIds.length) erros.push('Selecione pelo menos um item para compor o catanho.');
    if (d.itemIds.length > MAX_ITENS_POR_SOLICITACAO) erros.push(`Selecione no máximo ${MAX_ITENS_POR_SOLICITACAO} itens por solicitação.`);
    for (const id of d.itemIds) {
      const atual = catalogo.find(c => c.id === id);
      if (!atual || !atual.ativo) { erros.push('Um dos itens selecionados não está mais disponível.'); continue; }
      const total = d.quantidade;
      if (total > atual.saldo)
        erros.push(`${atual.nome}: estoque insuficiente (necessário ${qtdUn(total, atual.unidade)}; disponível ${qtdUn(Math.max(atual.saldo, 0), atual.unidade)}).`);
      itens.push({ id, nome: atual.nome, unidade: atual.unidade, quantidade: total });
    }
    return { erros, itens };
  }

  function formularioSolicitacao(mod, valores = {}) {
    const eventos = eventosOrdenados();
    const jaPedido = id => dados.solicitacoes.some(s => s.eventoId === id);
    const livres = eventos.filter(ev => !jaPedido(ev.id));
    const disponiveis = itensOrdenados().filter(i => i.ativo);
    const marcado = id => (valores.itemIds || []).includes(id);

    $('secSolicitacao').innerHTML = `
      <h2>Solicitação de catanhos</h2>
      <form id="fSol" novalidate>
        <label>Modalidade<input value="${esc(mod.nome)}" readonly></label>
        <label>Evento
          <select id="selEvento">
            <option value="">${!eventos.length ? 'Nenhum evento cadastrado para sua modalidade' : livres.length ? 'Selecione o evento' : 'Todos os eventos já possuem solicitação'}</option>
            ${eventos.map(ev => jaPedido(ev.id)
              ? `<option value="${ev.id}" disabled>${esc(nomeEvento(ev))} — já solicitado</option>`
              : `<option value="${ev.id}" ${ev.id === valores.eventoId ? 'selected' : ''}>${esc(nomeEvento(ev))}</option>`).join('')}
          </select>
        </label>
        <p class="muted small" style="margin-top:-.5rem">É permitida apenas uma solicitação por evento.</p>
        <label>Horário de retirada do catanho
          <input type="time" id="inpHora" value="${esc(valores.horario)}">
        </label>
        <label>Quantidade de catanhos
          <input type="number" id="inpQtd" min="1" step="1" inputmode="numeric" value="${editavel(valores.quantidade)}">
        </label>
        <p class="muted small" style="margin-top:-.5rem">
          ${mod.limite != null ? `Limite da modalidade: ${catanhos(mod.limite)}.` : 'Limite da modalidade ainda não definido pelo Administrador.'}
        </p>

        <h3 style="font-size:1rem;margin-top:1rem">Itens do catanho</h3>
        ${disponiveis.length ? `
        <p class="muted small" style="margin-top:-.3rem">Marque os itens que vão compor o catanho (até ${MAX_ITENS_POR_SOLICITACAO} itens). Cada item marcado terá a mesma quantidade de catanhos solicitada.</p>
        <div class="tabela-wrap itens-sol"><table>
          <thead><tr><th style="width:2.5rem"></th><th>Item</th><th>Unidade</th></tr></thead>
          <tbody>${disponiveis.map(i => {
            const semEstoque = !(i.saldo > 0);
            return `<tr class="${semEstoque ? 'linha-inativa' : ''}">
              <td><input type="checkbox" data-item="${i.id}" ${marcado(i.id) ? 'checked' : ''} ${semEstoque ? 'disabled' : ''} aria-label="${esc(i.nome)}" style="width:1.1rem;height:1.1rem;margin:0"></td>
              <td>${esc(i.nome)}${semEstoque ? ' <span class="status inativo">Sem estoque</span>' : ''}</td>
              <td>${esc(i.unidade)}</td>
            </tr>`;
          }).join('')}</tbody></table></div>` : '<p class="muted">Nenhum item disponível no momento.</p>'}

        <div class="erro" id="erroSol" style="margin-top:1rem"></div>
        <button class="btn primario" type="submit">Continuar</button>
      </form>`;

    $('fSol').onsubmit = e => {
      e.preventDefault();
      const erro = msg => { $('erroSol').textContent = msg; };
      const eventoId = $('selEvento').value;
      const horario = $('inpHora').value;
      const quantidade = paraInteiro($('inpQtd').value);
      if (!eventoId) return erro('Selecione o evento.');
      if (jaPedido(eventoId)) return erro('Já existe uma solicitação da sua modalidade para este evento. É permitida apenas uma solicitação por evento.');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(horario)) return erro('Informe o horário de retirada do catanho.');
      if (quantidade == null || Number.isNaN(quantidade) || quantidade < 1) return erro('Informe uma quantidade de catanhos válida (número inteiro maior que zero).');

      const itemIds = [...document.querySelectorAll('[data-item]:checked')].map(c => c.dataset.item);
      const d = { eventoId, horario, quantidade, itemIds };
      const { erros, itens } = validarSolicitacao(mod, d, dados.itens);
      if (erros.length) return erro(erros.join('\n'));
      d.itens = itens;
      resumoSolicitacao(mod, d);
    };
  }

  function resumoSolicitacao(mod, d) {
    // Identificador fixo "modalidade_evento": só pode existir uma solicitação por
    // evento para cada modalidade. Uma segunda gravação (ou uma confirmação repetida)
    // é recusada pelo Firestore, e o estoque não é baixado duas vezes.
    const solRef = doc(db, 'solicitacoes', `${mod.id}_${d.eventoId}`);
    const MSG_DUPLICADA = 'Já existe uma solicitação da sua modalidade para este evento. É permitida apenas uma solicitação por evento.';
    $('secSolicitacao').innerHTML = `
      <h2>Resumo da solicitação</h2>
      <p class="muted">Confira os dados antes de confirmar.</p>
      <dl class="resumo">
        <dt>Modalidade</dt><dd>${esc(mod.nome)}</dd>
        <dt>Evento</dt><dd>${esc(nomeEvento(evento(d.eventoId)))}</dd>
        <dt>Horário de retirada</dt><dd>${esc(d.horario)}</dd>
        <dt>Quantidade de catanhos</dt><dd>${fmtQtd(d.quantidade)}</dd>
        <dt>Itens</dt><dd>${d.itens.map(i => `${esc(i.nome)}: ${esc(qtdUn(i.quantidade, i.unidade))}`).join('<br>')}</dd>
      </dl>
      <div class="erro" id="erroConf"></div>
      <div class="acoes">
        <button class="btn primario" id="btnConfirmar">Confirmar Solicitação</button>
        <button class="btn secundario" id="btnVoltar">Voltar</button>
      </div>`;
    $('btnVoltar').onclick = () => formularioSolicitacao(mod, d);
    $('btnConfirmar').onclick = () => comBotao($('btnConfirmar'), async () => {
      const erro = msg => { $('erroConf').textContent = msg; };
      try {
        if ((await getDoc(solRef)).exists()) return erro(MSG_DUPLICADA);
      } catch (e) { return erro(msgErro(e)); }
      try {
        // Confere limite e estoque com os dados mais recentes.
        const [mSnap, ...snaps] = await Promise.all([
          getDoc(doc(db, 'modalidades', mod.id)),
          ...d.itemIds.map(id => getDoc(doc(db, 'itens', id)))
        ]);
        const modAtual = { id: mSnap.id, ...mSnap.data() };
        const catalogo = snaps.filter(s => s.exists()).map(s => ({ id: s.id, ...s.data() }));
        const { erros, itens } = validarSolicitacao(modAtual, d, catalogo);
        if (erros.length) return erro(erros.join('\n'));

        const itensMap = {};
        itens.forEach(i => { itensMap[i.id] = { nome: i.nome, unidade: i.unidade, quantidade: i.quantidade }; });

        // O pedido não mexe no estoque: a baixa é feita no "Fornecido".
        await setDoc(solRef, {
          modalidadeId: mod.id,
          eventoId: d.eventoId,
          horarioRetirada: d.horario,
          quantidade: d.quantidade,
          itens: itensMap,
          usuarioId: perfil.uid,
          usuarioNome: perfil.nome,
          status: 'pendente',
          baixaNoFornecimento: true,
          criadoEm: serverTimestamp()
        });
        telaResponsavel('Solicitação registrada com sucesso.');
      } catch (e) {
        // A solicitação não existia antes desta confirmação: se agora existe,
        // a gravação chegou ao servidor e só a resposta se perdeu.
        try {
          const ja = await getDoc(solRef);
          if (ja.exists()) return telaResponsavel('Solicitação registrada com sucesso.');
        } catch (_) { /* não existe ou sem acesso */ }
        erro(e.code === 'permission-denied'
          ? 'Não foi possível registrar: o estoque ou os limites foram alterados. Volte e revise a solicitação.'
          : msgErro(e));
      }
    });
  }

  /* ================= Administrador ================= */
  const ABAS = [
    ['solicitacoes', 'Solicitações'],
    ['itens', 'Itens e estoque'],
    ['modalidades', 'Modalidades e limites'],
    ['responsaveis', 'Responsáveis'],
    ['catanheiros', 'Catanheiros'],
    ['eventos', 'Eventos']
  ];

  async function garantirModalidades() {
    const atuais = await lista('modalidades');
    if (atuais.length) return ordenarModalidades(atuais);
    const b = writeBatch(db);
    MODALIDADES_INICIAIS.forEach((nome, i) =>
      b.set(doc(db, 'modalidades', 'm' + String(i + 1).padStart(2, '0')), { nome, limite: null, ordem: i + 1 }));
    await b.commit();
    return ordenarModalidades(await lista('modalidades'));
  }

  // Os dados são carregados ao entrar, ao clicar em "Atualizar" e após cada gravação.
  async function telaAdmin(aba, mensagem, recarregar) {
    if (recarregar) {
      app.innerHTML = CARREGANDO;
      try {
        const [modalidades, eventos, usuarios, solicitacoes, itens, movimentos] = await Promise.all([
          garantirModalidades(), lista('eventos'), lista('usuarios'), lista('solicitacoes'), lista('itens'), lista('movimentos')
        ]);
        dados = { modalidades, eventos, usuarios, solicitacoes, itens, movimentos };
      } catch (e) {
        return telaFalha('Administrador', e, () => telaAdmin(aba, '', true));
      }
    }
    app.innerHTML = cabecalho('Administrador', true) + `
      <nav class="abas">${ABAS.map(([k, t]) => `<button data-aba="${k}" class="${k === aba ? 'ativa' : ''}">${t}</button>`).join('')}</nav>
      <main class="conteudo">
        ${mensagem ? `<div class="aviso">${esc(mensagem)}</div>` : ''}
        <div id="painel"></div>
      </main>`;
    ligarSair();
    $('btnAtualizar').onclick = () => telaAdmin(aba, '', true);
    document.querySelectorAll('.abas button').forEach(b => b.onclick = () => telaAdmin(b.dataset.aba));
    PAINEIS[aba]($('painel'));
  }
  const salvo = (aba, msg) => telaAdmin(aba, msg, true);

  // Cria o login (Firebase Authentication) em uma instância separada,
  // para não desconectar o Administrador. Devolve o UID do novo usuário.
  async function criarAcesso(email, senha) {
    const appCadastro = initializeApp(cfg, 'cadastro-' + Date.now());
    try {
      const authCadastro = initializeAuth(appCadastro, { persistence: inMemoryPersistence });
      const cred = await createUserWithEmailAndPassword(authCadastro, email, senha);
      await signOut(authCadastro);
      return cred.user.uid;
    } finally {
      await deleteApp(appCadastro);
    }
  }

  /* ================= Catanheiro ================= */
  // Vê apenas solicitações autorizadas ("Pedido Recebido") e as já fornecidas,
  // e só pode marcar "Fornecido" (com baixa no estoque).
  async function telaCatanheiro(mensagem) {
    app.innerHTML = CARREGANDO;
    try {
      const [modalidades, eventos, solicitacoes] = await Promise.all([
        lista('modalidades'), lista('eventos'),
        listaConsulta(query(collection(db, 'solicitacoes'), where('status', 'in', ['recebido', 'fornecido'])))
      ]);
      dados = { ...vazio(), modalidades: ordenarModalidades(modalidades), eventos, solicitacoes };
    } catch (e) {
      return telaFalha('Catanheiro', e, () => telaCatanheiro());
    }
    app.innerHTML = cabecalho('Catanheiro', true) + `
      <main class="conteudo">
        ${mensagem ? `<div class="aviso">${esc(mensagem)}</div>` : ''}
        <div id="painel"></div>
      </main>`;
    ligarSair();
    $('btnAtualizar').onclick = () => telaCatanheiro();
    PAINEIS.solicitacoes($('painel'));
  }

  const botaoSalvar = (ed, id) => `<button class="btn primario" type="submit" id="${id}">${ed ? 'Salvar alterações' : 'Cadastrar'}</button>`;
  const botaoCancelar = ed => ed ? '<button class="btn secundario" type="button" id="btnCancelar">Cancelar edição</button>' : '';

  const PAINEIS = {
    /* ---- Solicitações ---- */
    solicitacoes(p) {
      const todas = dados.solicitacoes.slice().sort((a, b) => ms(b.criadoEm) - ms(a.criadoEm));
      const grupo = g => todas.filter(s => grupoDe(s) === g);
      const pend = grupo('pendentes'), rec = grupo('recebidos'), forn = grupo('fornecidos');
      const soma = l => l.reduce((t, s) => t + (s.quantidade || 0), 0);
      const visiveis = filtroSolicitacoes === 'todas' ? todas : grupo(filtroSolicitacoes);
      const indicador = (rotulo, l, destaque) => `<div class="indicador ${destaque ? 'destaque' : ''}">
        <div class="rotulo">${rotulo}</div><div class="valor">${fmtQtd(soma(l))}</div>
        <div class="small ${destaque ? '' : 'muted'}" ${destaque ? 'style="color:var(--azul-200)"' : ''}>${plural(l.length, 'solicitação', 'solicitações')}</div></div>`;

      const catanheiro = ctxSol.papel === 'catanheiro';
      const acoes = s => {
        const st = statusDe(s);
        if (st === 'pendente' && !catanheiro)
          return `<div style="margin-top:.35rem"><button class="btn primario pequeno" data-receber="${s.id}">Pedido Recebido</button></div>`;
        if (st === 'recebido')
          return `<div style="margin-top:.35rem"><button class="btn primario pequeno" data-fornecer="${s.id}">✓ Fornecido</button></div>`;
        if (st === 'fornecido')
          return `<div style="margin-top:.35rem"><button class="btn secundario pequeno" disabled title="Esta solicitação já foi fornecida">✓ Fornecido</button></div>`;
        return '';
      };

      p.innerHTML = `
      <div class="indicadores">
        ${catanheiro
          ? indicador('Catanhos a fornecer', rec, true) + indicador('Catanhos fornecidos', forn)
          : indicador('Catanhos pendentes', pend, true) + indicador('Pedidos recebidos', rec) + indicador('Catanhos fornecidos', forn) + indicador('Total de catanhos', todas)}
      </div>
      <section class="card">
        <h2>${catanheiro ? 'Solicitações autorizadas' : 'Solicitações'}</h2>
        <p class="muted small" style="margin-top:-.3rem">${catanheiro
          ? 'Aqui aparecem as solicitações autorizadas pelo Administrador ("Pedido Recebido"). Ao entregar o catanho, clique em "Fornecido": a baixa no estoque é feita nesse momento.'
          : 'Fluxo: Pendente → Pedido Recebido → Fornecido. A baixa no estoque ocorre somente no "Fornecido".'}</p>
        <div class="filtros">
          ${(catanheiro
            ? [['recebidos', 'A fornecer'], ['fornecidos', 'Fornecidos'], ['todas', 'Todas']]
            : [['todas', 'Todas'], ['pendentes', 'Pendentes'], ['recebidos', 'Pedido Recebido'], ['fornecidos', 'Fornecidos']]).map(([k, t]) =>
            `<button data-filtro="${k}" class="${filtroSolicitacoes === k ? 'ativo' : ''}">${t}</button>`).join('')}
        </div>
        <div class="erro" id="erroAtend"></div>
        ${visiveis.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Registrada em</th><th>Modalidade</th><th>Evento</th><th>Retirada</th><th class="num">Catanhos</th><th>Itens</th><th>Responsável</th><th>Status</th></tr></thead>
          <tbody>${visiveis.map(s => `<tr class="${classeLinha(s)}">
              <td>${fmtDataHora(s.criadoEm)}</td>
              <td>${esc(modalidade(s.modalidadeId)?.nome ?? '—')}</td>
              <td>${esc(nomeEvento(evento(s.eventoId)))}</td>
              <td>${esc(s.horarioRetirada || '—')}</td>
              <td class="num">${fmtQtd(s.quantidade)}</td>
              <td>${listaItensHtml(s)}</td>
              <td>${esc(s.usuarioNome || '—')}</td>
              <td>${seloStatus(s)}${historicoStatus(s)}${acoes(s)}</td>
            </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhuma solicitação neste filtro.</p>'}
      </section>`;

      const erro = msg => { $('erroAtend').textContent = msg; };
      const resumoTexto = s =>
        `Modalidade: ${modalidade(s.modalidadeId)?.nome ?? '—'}\n` +
        `Evento: ${nomeEvento(evento(s.eventoId))}\n` +
        `Retirada: ${s.horarioRetirada || '—'}\n` +
        `Catanhos: ${fmtQtd(s.quantidade)}`;

      p.querySelectorAll('[data-filtro]').forEach(b => b.onclick = () => { filtroSolicitacoes = b.dataset.filtro; PAINEIS.solicitacoes(p); });

      // ---- Pedido Recebido (não altera o estoque) ----
      p.querySelectorAll('[data-receber]').forEach(b => b.onclick = () => {
        const s = dados.solicitacoes.find(x => x.id === b.dataset.receber);
        if (!window.confirm(`Confirmar que este pedido foi recebido e registrado para atendimento?\n\n${resumoTexto(s)}\n\nO estoque não será alterado.`)) return;
        comBotao(b, async () => {
          try {
            await updateDoc(doc(db, 'solicitacoes', s.id), {
              status: 'recebido',
              recebidoEm: serverTimestamp(),
              recebidoPorUid: perfil.uid,
              recebidoPorNome: perfil.nome
            });
            ctxSol.recarregar('Solicitação marcada como Pedido Recebido.');
          } catch (err) {
            erro(err.code === 'permission-denied'
              ? 'Não foi possível marcar como Pedido Recebido: o status desta solicitação já foi alterado. Clique em Atualizar.'
              : msgErro(err));
          }
        });
      });

      // ---- Fornecido (baixa no estoque, uma única vez) ----
      p.querySelectorAll('[data-fornecer]').forEach(b => b.onclick = () => {
        const s = dados.solicitacoes.find(x => x.id === b.dataset.fornecer);
        const comBaixa = baixaNoFornecimento(s);
        const listaBaixa = itensDaSolicitacao(s).map(i => `• ${i.nome}: ${qtdUn(i.quantidade, i.unidade)}`).join('\n');
        const texto = `Confirmar que este catanho foi FORNECIDO ao responsável?\n\n${resumoTexto(s)}\n\n` +
          (comBaixa
            ? `Serão descontados do estoque:\n${listaBaixa}\n\nEsta ação não pode ser desfeita.`
            : 'Esta solicitação é anterior ao novo fluxo: o estoque já foi baixado e não será baixado novamente.');
        if (!window.confirm(texto)) return;

        comBotao(b, async () => {
          const solRef = doc(db, 'solicitacoes', s.id);
          try {
            // Confere o status atual no servidor (evita baixa duplicada após atualização da página).
            const atualSnap = await getDoc(solRef);
            const atual = { id: atualSnap.id, ...atualSnap.data() };
            if (statusDe(atual) === 'fornecido') return ctxSol.recarregar('Esta solicitação já estava marcada como Fornecido. Nenhuma nova baixa foi feita.');
            if (statusDe(atual) !== 'recebido') return erro('Esta solicitação precisa estar como "Pedido Recebido" antes de ser marcada como Fornecido.');

            const lote = writeBatch(db);
            lote.update(solRef, {
              status: 'fornecido',
              fornecidoEm: serverTimestamp(),
              fornecidoPorUid: perfil.uid,
              fornecidoPorNome: perfil.nome
            });
            if (baixaNoFornecimento(atual)) {
              const lista = itensDaSolicitacao(atual);
              const snaps = await Promise.all(lista.map(i => getDoc(doc(db, 'itens', i.id))));
              const faltas = [];
              lista.forEach((i, k) => {
                const it = snaps[k].exists() ? snaps[k].data() : null;
                if (!it) faltas.push(`${i.nome}: item não encontrado no cadastro.`);
                else if (it.saldo < i.quantidade)
                  faltas.push(`${i.nome}: estoque insuficiente (necessário ${qtdUn(i.quantidade, i.unidade)}; disponível ${qtdUn(Math.max(it.saldo, 0), it.unidade)}).`);
              });
              if (faltas.length) return erro('Não foi possível marcar como Fornecido:\n' + faltas.join('\n') + '\nRegistre uma entrada no estoque e tente novamente.');
              lista.forEach(i => lote.update(doc(db, 'itens', i.id), {
                saldo: increment(-i.quantidade),
                saidas: increment(i.quantidade),
                ultimaBaixa: s.id,
                ultimaBaixaEm: serverTimestamp()
              }));
            }
            await lote.commit();
            ctxSol.recarregar(baixaNoFornecimento(atual)
              ? 'Solicitação marcada como Fornecido e baixa realizada no estoque.'
              : 'Solicitação marcada como Fornecido.');
          } catch (err) {
            // Se a gravação chegou ao servidor e só a resposta se perdeu, não repete.
            try {
              const depois = await getDoc(solRef);
              if (depois.exists() && depois.data().status === 'fornecido')
                return ctxSol.recarregar('Solicitação marcada como Fornecido.');
            } catch (_) { /* sem acesso ou sem conexão */ }
            erro(err.code === 'permission-denied'
              ? 'Não foi possível marcar como Fornecido: o estoque ou o status foi alterado. Clique em Atualizar e tente novamente.'
              : msgErro(err));
          }
        });
      });
    },

    /* ---- Itens e estoque ---- */
    itens(p, editId) {
      const ed = editId ? item(editId) : null;
      const temMovimento = ed && (ed.entradas > 0 || ed.saidas > 0);
      const l = itensOrdenados();

      // Movimentações: estoque inicial e entradas (registradas pelo Administrador)
      // e saídas (registradas em cada solicitação).
      const movs = [
        ...dados.movimentos.map(m => ({
          quando: m.criadoEm, itemNome: m.itemNome, tipo: m.tipo === 'inicial' ? 'Estoque inicial' : 'Entrada',
          quantidade: m.quantidade, unidade: item(m.itemId)?.unidade ?? '', origem: m.porNome || '—', saida: false
        })),
        ...dados.solicitacoes.filter(estoqueBaixado).flatMap(s => itensDaSolicitacao(s).map(i => ({
          quando: dataDaBaixa(s), itemNome: i.nome, tipo: 'Saída', quantidade: i.quantidade, unidade: i.unidade,
          origem: `Fornecido · ${modalidade(s.modalidadeId)?.nome ?? '—'}${s.fornecidoPorNome ? ' · por ' + s.fornecidoPorNome : ''}`, saida: true
        })))
      ].sort((a, b) => ms(b.quando) - ms(a.quando));

      p.innerHTML = `
      <section class="card">
        <h2>${ed ? 'Editar item' : 'Cadastrar item'}</h2>
        <form id="fItem" novalidate>
          <div class="grade">
            <label>Nome do item<input name="nome" value="${esc(ed?.nome)}"></label>
            <label>Unidade de medida<input name="unidade" list="listaUnidades" value="${esc(ed?.unidade)}" placeholder="un, pct, kg…"></label>
            <label>Estoque inicial<input type="number" min="0" step="1" inputmode="numeric" name="inicial" value="${editavel(ed?.estoqueInicial)}" ${temMovimento ? 'readonly' : ''}></label>
          </div>
          <datalist id="listaUnidades">${UNIDADES.map(u => `<option value="${u}">`).join('')}</datalist>
          <p class="muted small" style="margin-top:-.4rem">Use números inteiros. Em cada solicitação, o item é descontado na mesma quantidade de catanhos pedida.${temMovimento ? ' Este item já tem movimentações; para aumentar o estoque, registre uma entrada.' : ''}</p>
          <div class="erro" id="erroItem"></div>
          <div class="acoes">${botaoSalvar(ed, 'btnItem')}${botaoCancelar(ed)}</div>
        </form>
      </section>

      ${l.length ? `
      <section class="card">
        <h2>Registrar entrada no estoque</h2>
        <form id="fEntrada" novalidate>
          <div class="grade">
            <label>Item
              <select name="item">
                <option value="">Selecione</option>
                ${l.map(i => `<option value="${i.id}">${esc(i.nome)} (saldo: ${esc(qtdUn(i.saldo, i.unidade))})</option>`).join('')}
              </select>
            </label>
            <label>Quantidade de entrada<input type="number" min="1" step="1" inputmode="numeric" name="qtd"></label>
          </div>
          <div class="erro" id="erroEntrada"></div>
          <button class="btn primario" type="submit" id="btnEntrada">Registrar entrada</button>
        </form>
      </section>` : ''}

      <section class="card">
        <h2>Itens cadastrados e estoque atual</h2>
        <div class="erro" id="erroLista"></div>
        ${l.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Item</th><th>Unidade</th><th class="num">Estoque inicial</th><th class="num">Entradas</th><th class="num">Saídas</th><th class="num">Saldo</th><th>Situação</th><th></th></tr></thead>
          <tbody>${l.map(i => `<tr class="${i.ativo ? '' : 'linha-inativa'}">
            <td><strong>${esc(i.nome)}</strong></td><td>${esc(i.unidade)}</td>
            <td class="num">${fmtQtd(i.estoqueInicial)}</td>
            <td class="num">${fmtQtd(i.entradas)}</td>
            <td class="num">${fmtQtd(i.saidas)}</td>
            <td class="num"><strong>${fmtQtd(i.saldo)}</strong></td>
            <td>${i.ativo ? '<span class="status ativo">Ativo</span>' : '<span class="status inativo">Inativo</span>'}</td>
            <td class="num" style="white-space:nowrap">
              <button class="btn secundario pequeno" data-edit="${i.id}">Editar</button>
              <button class="btn secundario pequeno" data-ativo="${i.id}">${i.ativo ? 'Desativar' : 'Ativar'}</button>
            </td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhum item cadastrado.</p>'}
      </section>

      <section class="card">
        <h2>Movimentações de estoque</h2>
        ${movs.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Data</th><th>Item</th><th>Tipo</th><th class="num">Quantidade</th><th>Origem</th></tr></thead>
          <tbody>${movs.map(m => `<tr>
            <td>${fmtDataHora(m.quando)}</td><td>${esc(m.itemNome)}</td><td>${m.tipo}</td>
            <td class="num">${m.saida ? '−' : '+'}${esc(qtdUn(m.quantidade, m.unidade))}</td><td>${esc(m.origem)}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhuma movimentação registrada.</p>'}
      </section>`;

      p.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => PAINEIS.itens(p, b.dataset.edit));
      if (ed) $('btnCancelar').onclick = () => PAINEIS.itens(p);

      p.querySelectorAll('[data-ativo]').forEach(b => b.onclick = () => comBotao(b, async () => {
        const i = item(b.dataset.ativo);
        try {
          await updateDoc(doc(db, 'itens', i.id), { ativo: !i.ativo });
          salvo('itens', `Item ${i.nome} ${i.ativo ? 'desativado' : 'ativado'}.`);
        } catch (err) { $('erroLista').textContent = msgErro(err); }
      }));

      $('fItem').onsubmit = e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const erro = msg => { $('erroItem').textContent = msg; };
        const nome = String(f.get('nome')).trim();
        const unidade = String(f.get('unidade')).trim();
        const inicial = paraInteiro(f.get('inicial'));
        if (!nome) return erro('Informe o nome do item.');
        if (dados.itens.some(i => i.nome.toLowerCase() === nome.toLowerCase() && i.id !== ed?.id)) return erro('Já existe um item com este nome.');
        if (!unidade) return erro('Informe a unidade de medida.');
        if (inicial == null || Number.isNaN(inicial) || inicial < 0) return erro('Informe o estoque inicial (número inteiro, zero ou mais).');

        comBotao($('btnItem'), async () => {
          try {
            if (ed) {
              const alt = { nome, unidade };
              if (!temMovimento && inicial !== ed.estoqueInicial) { alt.estoqueInicial = inicial; alt.saldo = inicial; }
              await updateDoc(doc(db, 'itens', ed.id), alt);
              return salvo('itens', 'Item atualizado.');
            }
            const ref = doc(collection(db, 'itens'));
            const lote = writeBatch(db);
            lote.set(ref, {
              nome, unidade, ativo: true,
              estoqueInicial: inicial, entradas: 0, saidas: 0, saldo: inicial, ultimaBaixa: ''
            });
            lote.set(doc(collection(db, 'movimentos')), {
              itemId: ref.id, itemNome: nome, tipo: 'inicial', quantidade: inicial,
              criadoEm: serverTimestamp(), porUid: perfil.uid, porNome: perfil.nome
            });
            await lote.commit();
            salvo('itens', 'Item cadastrado.');
          } catch (err) { erro(msgErro(err)); }
        });
      };

      if (l.length) $('fEntrada').onsubmit = e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const erro = msg => { $('erroEntrada').textContent = msg; };
        const i = item(String(f.get('item')));
        const q = paraInteiro(f.get('qtd'));
        if (!i) return erro('Selecione o item.');
        if (q == null || Number.isNaN(q) || q < 1) return erro('Informe uma quantidade de entrada válida (número inteiro maior que zero).');
        comBotao($('btnEntrada'), async () => {
          try {
            const lote = writeBatch(db);
            lote.update(doc(db, 'itens', i.id), { entradas: increment(q), saldo: increment(q) });
            lote.set(doc(collection(db, 'movimentos')), {
              itemId: i.id, itemNome: i.nome, tipo: 'entrada', quantidade: q,
              criadoEm: serverTimestamp(), porUid: perfil.uid, porNome: perfil.nome
            });
            await lote.commit();
            salvo('itens', `Entrada de ${qtdUn(q, i.unidade)} registrada para ${i.nome}.`);
          } catch (err) { erro(msgErro(err)); }
        });
      };
    },

    /* ---- Modalidades e limites ---- */
    modalidades(p) {
      p.innerHTML = `<section class="card">
        <h2>Modalidades e limite máximo de catanhos</h2>
        <form id="fMod" novalidate>
          <div class="tabela-wrap"><table>
            <thead><tr><th>#</th><th>Modalidade</th><th>Limite máximo de catanhos</th><th>Responsável</th></tr></thead>
            <tbody>${dados.modalidades.map((m, i) => {
              const resp = dados.usuarios.find(u => u.modalidadeId === m.id);
              return `<tr>
                <td>${i + 1}</td>
                <td><input name="nome_${m.id}" value="${esc(m.nome)}"></td>
                <td><input type="number" min="0" step="1" name="lim_${m.id}" value="${m.limite ?? ''}" placeholder="Não definido"></td>
                <td>${resp ? esc(resp.nome) : '<span class="muted">—</span>'}</td>
              </tr>`;
            }).join('')}</tbody></table></div>
          <div class="erro" id="erroMod" style="margin-top:.8rem"></div>
          <button class="btn primario" type="submit" id="btnMod">Salvar alterações</button>
        </form></section>`;

      $('fMod').onsubmit = e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const erro = msg => { $('erroMod').textContent = msg; };
        const novos = [];
        for (const m of dados.modalidades) {
          const nome = String(f.get('nome_' + m.id)).trim();
          const limite = inteiro(f.get('lim_' + m.id));
          if (!nome) return erro('Todas as modalidades precisam de um nome.');
          if (Number.isNaN(limite) || (limite != null && limite < 0)) return erro(`Limite inválido para "${nome}".`);
          novos.push({ m, nome, limite });
        }
        const nomes = novos.map(n => n.nome.toLowerCase());
        if (new Set(nomes).size !== nomes.length) return erro('Existem modalidades com nomes repetidos.');
        const alterados = novos.filter(n => n.nome !== n.m.nome || n.limite !== (n.m.limite ?? null));
        if (!alterados.length) return erro('Nenhuma alteração para salvar.');
        comBotao($('btnMod'), async () => {
          try {
            const b = writeBatch(db);
            alterados.forEach(n => b.update(doc(db, 'modalidades', n.m.id), { nome: n.nome, limite: n.limite }));
            await b.commit();
            salvo('modalidades', 'Modalidades atualizadas.');
          } catch (err) { erro(msgErro(err)); }
        });
      };
    },

    /* ---- Catanheiros ---- */
    catanheiros(p, editId) {
      const lst = dados.usuarios.filter(u => u.perfil === 'catanheiro').sort((a, b) => a.nome.localeCompare(b.nome));
      const ed = editId ? dados.usuarios.find(u => u.id === editId) : null;
      p.innerHTML = `
      <section class="card">
        <h2>${ed ? 'Editar catanheiro' : 'Cadastrar catanheiro'}</h2>
        <p class="muted small" style="margin-top:-.3rem">O catanheiro vê apenas as solicitações autorizadas ("Pedido Recebido") e só pode marcá-las como "Fornecido". Não acessa itens, estoque, limites, eventos nem cadastros.</p>
        <form id="fCat" novalidate>
          <div class="grade">
            <label>Nome<input name="nome" value="${esc(ed?.nome)}"></label>
            <label>Usuário/e-mail<input type="email" name="email" value="${esc(ed?.email)}" autocomplete="off" ${ed ? 'readonly' : ''}></label>
            ${ed ? '' : '<label>Senha inicial<input type="password" name="senha" autocomplete="new-password" placeholder="Mínimo de 6 caracteres"></label>'}
          </div>
          ${ed ? '<p class="muted small" style="margin-top:-.4rem">O e-mail de acesso não pode ser alterado. Para trocar a senha, envie o e-mail de redefinição.</p>' : ''}
          <div class="erro" id="erroCat"></div>
          <div class="acoes">
            ${botaoSalvar(ed, 'btnCat')}
            ${ed ? '<button class="btn secundario" type="button" id="btnRedefinir">Enviar e-mail de redefinição de senha</button>' : ''}
            ${botaoCancelar(ed)}
          </div>
        </form>
      </section>
      <section class="card">
        <h2>Catanheiros cadastrados</h2>
        ${lst.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Nome</th><th>Usuário/e-mail</th><th></th></tr></thead>
          <tbody>${lst.map(u => `<tr>
            <td>${esc(u.nome)}</td><td>${esc(u.email)}</td>
            <td class="num"><button class="btn secundario pequeno" data-edit="${u.id}">Editar</button></td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhum catanheiro cadastrado.</p>'}
      </section>`;

      p.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => PAINEIS.catanheiros(p, b.dataset.edit));
      const erro = msg => { $('erroCat').textContent = msg; };
      if (ed) {
        $('btnCancelar').onclick = () => PAINEIS.catanheiros(p);
        $('btnRedefinir').onclick = () => comBotao($('btnRedefinir'), async () => {
          try {
            await sendPasswordResetEmail(auth, ed.email);
            erro('');
            p.insertAdjacentHTML('afterbegin', `<div class="aviso">E-mail de redefinição enviado para ${esc(ed.email)}.</div>`);
          } catch (err) { erro(msgErro(err)); }
        });
      }

      $('fCat').onsubmit = e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const nome = String(f.get('nome')).trim();
        const email = ed ? ed.email : String(f.get('email')).trim();
        const senha = ed ? '' : String(f.get('senha'));
        if (!nome) return erro('Informe o nome.');
        if (!ed && !/^\S+@\S+\.\S+$/.test(email)) return erro('Informe um e-mail válido.');
        if (!ed && senha.length < 6) return erro('A senha inicial deve ter pelo menos 6 caracteres.');
        comBotao($('btnCat'), async () => {
          try {
            if (ed) {
              await updateDoc(doc(db, 'usuarios', ed.id), { nome });
              return salvo('catanheiros', 'Catanheiro atualizado.');
            }
            const uid = await criarAcesso(email, senha);
            try {
              await setDoc(doc(db, 'usuarios', uid), { nome, email, perfil: 'catanheiro' });
            } catch (err) {
              return erro('O acesso foi criado, mas o perfil não foi salvo (' + msgErro(err) + ').');
            }
            salvo('catanheiros', 'Catanheiro cadastrado.');
          } catch (err) { erro(msgErro(err)); }
        });
      };
    },

    /* ---- Responsáveis ---- */
    responsaveis(p, editId) {
      const resp = dados.usuarios.filter(u => u.perfil === 'responsavel').sort((a, b) => a.nome.localeCompare(b.nome));
      const ed = editId ? dados.usuarios.find(u => u.id === editId) : null;
      p.innerHTML = `
      <section class="card">
        <h2>${ed ? 'Editar responsável' : 'Cadastrar responsável'}</h2>
        <form id="fResp" novalidate>
          <div class="grade">
            <label>Nome<input name="nome" value="${esc(ed?.nome)}"></label>
            <label>Usuário/e-mail<input type="email" name="email" value="${esc(ed?.email)}" autocomplete="off" ${ed ? 'readonly' : ''}></label>
            ${ed ? '' : '<label>Senha inicial<input type="password" name="senha" autocomplete="new-password" placeholder="Mínimo de 6 caracteres"></label>'}
            <label>Modalidade
              <select name="modalidade">
                <option value="">Selecione</option>
                ${dados.modalidades.map(m => `<option value="${m.id}" ${ed?.modalidadeId === m.id ? 'selected' : ''}>${esc(m.nome)}</option>`).join('')}
              </select>
            </label>
          </div>
          ${ed ? '<p class="muted small" style="margin-top:-.4rem">O e-mail de acesso não pode ser alterado. Para trocar a senha, envie o e-mail de redefinição ao responsável.</p>' : ''}
          <div class="erro" id="erroResp"></div>
          <div class="acoes">
            ${botaoSalvar(ed, 'btnResp')}
            ${ed ? '<button class="btn secundario" type="button" id="btnRedefinir">Enviar e-mail de redefinição de senha</button>' : ''}
            ${botaoCancelar(ed)}
          </div>
        </form>
      </section>
      <section class="card">
        <h2>Responsáveis cadastrados</h2>
        ${resp.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Nome</th><th>Usuário/e-mail</th><th>Modalidade</th><th></th></tr></thead>
          <tbody>${resp.map(u => `<tr>
            <td>${esc(u.nome)}</td><td>${esc(u.email)}</td><td>${esc(modalidade(u.modalidadeId)?.nome ?? '—')}</td>
            <td class="num"><button class="btn secundario pequeno" data-edit="${u.id}">Editar</button></td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhum responsável cadastrado.</p>'}
      </section>`;

      p.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => PAINEIS.responsaveis(p, b.dataset.edit));
      const erro = msg => { $('erroResp').textContent = msg; };

      if (ed) {
        $('btnCancelar').onclick = () => PAINEIS.responsaveis(p);
        $('btnRedefinir').onclick = () => comBotao($('btnRedefinir'), async () => {
          try {
            await sendPasswordResetEmail(auth, ed.email);
            erro('');
            p.insertAdjacentHTML('afterbegin', `<div class="aviso">E-mail de redefinição enviado para ${esc(ed.email)}.</div>`);
          } catch (err) { erro(msgErro(err)); }
        });
      }

      $('fResp').onsubmit = e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const nome = String(f.get('nome')).trim();
        const email = ed ? ed.email : String(f.get('email')).trim();
        const senha = ed ? '' : String(f.get('senha'));
        const modId = String(f.get('modalidade'));
        if (!nome) return erro('Informe o nome.');
        if (!ed && !/^\S+@\S+\.\S+$/.test(email)) return erro('Informe um e-mail válido.');
        if (!ed && senha.length < 6) return erro('A senha inicial deve ter pelo menos 6 caracteres.');
        if (!modId) return erro('Selecione a modalidade.');
        const ocupante = dados.usuarios.find(u => u.modalidadeId === modId && u.id !== ed?.id);
        if (ocupante) return erro(`A modalidade selecionada já possui o responsável ${ocupante.nome}.`);

        comBotao($('btnResp'), async () => {
          try {
            if (ed) {
              await updateDoc(doc(db, 'usuarios', ed.id), { nome, modalidadeId: modId });
              return salvo('responsaveis', 'Responsável atualizado.');
            }
            const uid = await criarAcesso(email, senha);
            try {
              await setDoc(doc(db, 'usuarios', uid), { nome, email, perfil: 'responsavel', modalidadeId: modId });
            } catch (err) {
              return erro('O acesso foi criado, mas o perfil não foi salvo (' + msgErro(err) + ').');
            }
            salvo('responsaveis', 'Responsável cadastrado.');
          } catch (err) { erro(msgErro(err)); }
        });
      };
    },

    /* ---- Eventos ---- */
    eventos(p, editId) {
      const ed = editId ? evento(editId) : null;
      const l = eventosOrdenados();
      p.innerHTML = `
      <section class="card">
        <h2>${ed ? 'Editar evento' : 'Cadastrar evento'}</h2>
        <form id="fEv" novalidate>
          <div class="grade">
            <label>Modalidade
              <select name="modalidade">
                <option value="">Selecione</option>
                ${dados.modalidades.map(m => `<option value="${m.id}" ${ed?.modalidadeId === m.id ? 'selected' : ''}>${esc(m.nome)}</option>`).join('')}
              </select>
            </label>
            <label>Nome do evento<input name="nome" value="${esc(ed?.nome)}"></label>
            <label>Data<input type="date" name="data" value="${esc(ed?.data)}"></label>
            <label>Local<input name="local" value="${esc(ed?.local)}"></label>
          </div>
          <div class="erro" id="erroEv"></div>
          <div class="acoes">${botaoSalvar(ed, 'btnEv')}${botaoCancelar(ed)}</div>
        </form>
      </section>
      <section class="card">
        <h2>Eventos cadastrados</h2>
        ${l.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Evento</th><th>Modalidade</th><th>Data</th><th>Local</th><th></th></tr></thead>
          <tbody>${l.map(ev => `<tr>
            <td>${esc(ev.nome)}</td>
            <td>${modalidade(ev.modalidadeId) ? esc(modalidade(ev.modalidadeId).nome) : '<span class="status pendente">Sem modalidade</span>'}</td>
            <td>${fmtData(ev.data)}</td><td>${esc(ev.local || '—')}</td>
            <td class="num"><button class="btn secundario pequeno" data-edit="${ev.id}">Editar</button></td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhum evento cadastrado.</p>'}
      </section>`;

      p.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => PAINEIS.eventos(p, b.dataset.edit));
      if (ed) $('btnCancelar').onclick = () => PAINEIS.eventos(p);

      $('fEv').onsubmit = e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const modalidadeId = String(f.get('modalidade'));
        const nome = String(f.get('nome')).trim();
        const data = String(f.get('data'));
        const local = String(f.get('local')).trim();
        const erro = msg => { $('erroEv').textContent = msg; };
        if (!modalidadeId) return erro('Selecione a modalidade do evento.');
        if (!nome) return erro('Informe o nome do evento.');
        if (!data) return erro('Informe a data do evento.');
        comBotao($('btnEv'), async () => {
          try {
            if (ed) await updateDoc(doc(db, 'eventos', ed.id), { modalidadeId, nome, data, local });
            else await addDoc(collection(db, 'eventos'), { modalidadeId, nome, data, local });
            salvo('eventos', ed ? 'Evento atualizado.' : 'Evento cadastrado.');
          } catch (err) { erro(msgErro(err)); }
        });
      };
    }
  };
})();
