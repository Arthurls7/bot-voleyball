const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const cron = require("node-cron");

const ARQUIVO_DADOS = "./dados.json";

function carregarDados() {
  if (fs.existsSync(ARQUIVO_DADOS)) return JSON.parse(fs.readFileSync(ARQUIVO_DADOS, "utf8"));
  return { config: {}, apelidos: {}, listaPrincipal: [], listaReservas: [], listaEspera: [] };
}
function salvarDados(d) { fs.writeFileSync(ARQUIVO_DADOS, JSON.stringify(d, null, 2)); }

let dados = carregarDados();

const CONFIG          = () => dados.config;
const isAdmin         = (n) => CONFIG().ADMINS.some((p) => p.numero === n);
const isFixo          = (n) => CONFIG().ADMINS.some((p) => p.numero === n) || CONFIG().FIXOS.some((p) => p.numero !== null && p.numero === n);
const getFixoByNumero = (n) => CONFIG().ADMINS.find((p) => p.numero === n) || CONFIG().FIXOS.find((p) => p.numero === n) || null;
const getFixoByNome   = (nome) => CONFIG().FIXOS.find((p) => p.nome.toLowerCase() === nome.toLowerCase()) || null;

function getApelido(numero) { return dados.apelidos?.[numero] || null; }
function setApelido(numero, nome) {
  if (!dados.apelidos) dados.apelidos = {};
  dados.apelidos[numero] = nome;
  salvarDados(dados);
}
function nomeExibicao(numero, nomeWpp) {
  return getApelido(numero) || getFixoByNumero(numero)?.nome || nomeWpp;
}

function listaEstaAberta() {
  const abertura   = CONFIG().HORARIO_ENVIO_LISTA;
  const fechamento = CONFIG().HORARIO_FECHAMENTO_LISTA;
  if (!abertura || !fechamento) return true;
  const agora     = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const minAtual  = agora.getDay() * 1440 + agora.getHours() * 60 + agora.getMinutes();
  const minAbre   = abertura.diaSemana   * 1440 + abertura.hora   * 60 + abertura.minuto;
  const minFecha  = fechamento.diaSemana * 1440 + fechamento.hora * 60 + fechamento.minuto;
  return minAtual >= minAbre && minAtual < minFecha;
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },
});

client.on("qr", (qr) => { console.log("\nEscaneie o QR Code:\n"); qrcode.generate(qr, { small: true }); });
client.on("ready", () => { console.log("Bot pronto!"); agendarEnvioSemanal(); });
client.on("auth_failure", () => { console.error("Falha na autenticacao."); });

client.on("message", async (msg) => {
  try {
    if (msg.from === "status@broadcast") return;
    let chat;
    try { chat = await msg.getChat(); } catch (e) { return; }
    if (!chat.isGroup) return;

    dados = carregarDados();

    const contato = await msg.getContact();
    const numero  = contato.number;
    const nomeWpp = contato.pushname || contato.name || numero;
    const texto   = msg.body.trim();
    const ok      = chat.id._serialized === CONFIG().GROUP_ID;
    const meuNome = nomeExibicao(numero, nomeWpp);

    // Bloqueia comandos de lista fora do horário
    const _cmdTexto      = texto.toLowerCase().split(" ")[0];
    const _comandosLista = CONFIG().COMANDOS_LISTA || [];
    if (ok && _comandosLista.includes(_cmdTexto) && !listaEstaAberta()) {
      const hA   = CONFIG().HORARIO_ENVIO_LISTA;
      const dias = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
      const fmtAbertura = hA
        ? `${dias[hA.diaSemana] ?? `dia ${hA.diaSemana}`} às ${String(hA.hora).padStart(2, "0")}:${String(hA.minuto).padStart(2, "0")}h`
        : "em breve";
      await msg.reply(`⏸️ A lista não está em andamento no momento.\n_Aguarde o horário de abertura: ${fmtAbertura}_`);
      return;
    }

    // .apelido NovoNome
    if (texto.toLowerCase().startsWith(".apelido ")) {
      if (!ok) return;
      const novoNome = texto.slice(9).trim();
      if (!novoNome) { await msg.reply("❓ Use: .apelido Seu Apelido"); return; }
      const apelidoAnterior = getApelido(numero);
      setApelido(numero, novoNome);
      const jaP = dados.listaPrincipal.find((p) => p.numero === numero);
      const jaE = dados.listaEspera.find((p) => p.numero === numero);
      if (jaP) { jaP.nome = novoNome; salvarDados(dados); }
      else if (jaE) { jaE.nome = novoNome; salvarDados(dados); }
      const sufixo   = (jaP || jaE) ? " _(lista atualizada)_" : "";
      const anterior = apelidoAnterior ? `\nAntes: *${apelidoAnterior}*.` : "";
      await msg.reply(`✏️ Apelido definido como *${novoNome}*.${anterior}${sufixo}\n_Use .entrar para entrar com esse nome._`);
      return;
    }

    // .entrar / .entrar NomeFixo
    if (texto.toLowerCase() === ".entrar" || texto.toLowerCase().startsWith(".entrar ")) {
      if (!ok) return;
      const param = texto.length > 7 ? texto.slice(7).trim() : null;

      if (param) {
        if (!isFixo(numero)) {
          await msg.reply(`⛔ *${meuNome}*, apenas fixos podem confirmar a entrada de outras pessoas.\n_Para entrar na lista use apenas .entrar_`);
          return;
        }
        const cadastro = getFixoByNome(param);
        if (!cadastro || cadastro.numero !== null) {
          await msg.reply(`❓ *${param}* não é um fixo sem número cadastrado.\n_Para entrar na lista use apenas .entrar_`);
          return;
        }
        const jaP = dados.listaPrincipal.find((p) => p.numero === null && p.nome.toLowerCase() === cadastro.nome.toLowerCase());
        const jaE = dados.listaEspera.find((p) => p.numero === null && p.nome.toLowerCase() === cadastro.nome.toLowerCase());
        if (jaP) { await msg.reply(`✅ *${cadastro.nome}* já está na lista principal!`); return; }
        if (jaE) {
          const pos = dados.listaEspera.findIndex((p) => p.numero === null && p.nome.toLowerCase() === cadastro.nome.toLowerCase()) + 1;
          await msg.reply(`⏳ *${cadastro.nome}* já está na lista de espera (posição ${pos}).`);
          return;
        }
        if (dados.listaPrincipal.length < CONFIG().LIMITE_LISTA_PRINCIPAL) {
          dados.listaPrincipal.push({ nome: cadastro.nome, numero: null, adicionadoEm: new Date().toISOString(), confirmadoPor: meuNome });
          salvarDados(dados);
          await msg.reply(`✅ *${cadastro.nome}* adicionado à lista principal! (${dados.listaPrincipal.length}/${CONFIG().LIMITE_LISTA_PRINCIPAL})\n_Confirmado por: ${meuNome}_`);
        } else {
          dados.listaEspera.push({ nome: cadastro.nome, numero: null, adicionadoEm: new Date().toISOString(), convidadoPor: numero, convidadoPorNome: meuNome });
          salvarDados(dados);
          await msg.reply(`⏳ Lista cheia. *${cadastro.nome}* foi para a espera (posição ${dados.listaEspera.length}).\n_Confirmado por: ${meuNome}_`);
        }
        return;
      }

      const nome = meuNome;
      const jaP = dados.listaPrincipal.find((p) => p.numero === numero);
      const jaE = dados.listaEspera.find((p) => p.numero === numero);
      if (jaP) { await msg.reply(`✅ *${jaP.nome}*, você já está na lista principal!`); return; }
      if (jaE) {
        const pos = dados.listaEspera.findIndex((p) => p.numero === numero) + 1;
        await msg.reply(`⏳ *${jaE.nome}*, você já está na lista de espera (posição ${pos}).`);
        return;
      }
      if (isFixo(numero) && dados.listaPrincipal.length < CONFIG().LIMITE_LISTA_PRINCIPAL) {
        dados.listaPrincipal.push({ nome, numero, adicionadoEm: new Date().toISOString() });
        salvarDados(dados);
        await msg.reply(`✅ *${nome}*, você foi adicionado à lista principal! (${dados.listaPrincipal.length}/${CONFIG().LIMITE_LISTA_PRINCIPAL})`);
      } else {
        dados.listaEspera.push({ nome, numero, adicionadoEm: new Date().toISOString(), convidadoPor: null });
        salvarDados(dados);
        const motivo = isFixo(numero) ? "a lista principal está cheia" : "você não está nos fixos";
        await msg.reply(`⏳ *${nome}*, ${motivo}. Você foi para a lista de espera (posição ${dados.listaEspera.length}).`);
      }
    }

    // .sair
    else if (texto.toLowerCase() === ".sair") {
      if (!ok) return;
      const iP = dados.listaPrincipal.findIndex((p) => p.numero === numero);
      const iE = dados.listaEspera.findIndex((p) => p.numero === numero);
      if (iP !== -1) {
        const nome = dados.listaPrincipal[iP].nome;
        dados.listaPrincipal.splice(iP, 1); salvarDados(dados);
        await msg.reply(`👋 *${nome}*, você saiu da lista principal.`);
      } else if (iE !== -1) {
        const nome = dados.listaEspera[iE].nome;
        dados.listaEspera.splice(iE, 1); salvarDados(dados);
        await msg.reply(`👋 *${nome}*, você saiu da lista de espera.`);
      } else {
        await msg.reply(`❓ *${meuNome}*, você não está em nenhuma lista.`);
      }
    }

    // .convidar Nome
    else if (texto.toLowerCase().startsWith(".convidar ")) {
      if (!ok) return;
      const nomeConv = texto.slice(10).trim();
      if (!nomeConv) { await msg.reply("❓ Use: .convidar Nome do Convidado"); return; }
      const nomeConvLower = nomeConv.toLowerCase();
      const naPrincipal = dados.listaPrincipal.find((p) => p.nome.toLowerCase() === nomeConvLower);
      const naEspera    = dados.listaEspera.find((p) => p.nome.toLowerCase() === nomeConvLower);
      if (naPrincipal) { await msg.reply(`⚠️ *${nomeConv}* já está na lista principal!`); return; }
      if (naEspera) { await msg.reply(`⚠️ *${nomeConv}* já está na lista de espera!${naEspera.convidadoPorNome ? ` Convidado por ${naEspera.convidadoPorNome}.` : ""}`); return; }
      if (dados.listaPrincipal.length < CONFIG().LIMITE_LISTA_PRINCIPAL) {
        dados.listaPrincipal.push({ nome: nomeConv, numero: null, adicionadoEm: new Date().toISOString(), convidadoPor: numero, convidadoPorNome: meuNome, convidado: true, pago: false });
        salvarDados(dados);
        await msg.reply(`✅ *${nomeConv}* adicionado à lista principal! (${dados.listaPrincipal.length}/${CONFIG().LIMITE_LISTA_PRINCIPAL})\n_Convidado por: ${meuNome} · ⏳ Aguardando pagamento_`);
      } else {
        dados.listaEspera.push({ nome: nomeConv, numero: null, adicionadoEm: new Date().toISOString(), convidadoPor: numero, convidadoPorNome: meuNome });
        salvarDados(dados);
        await msg.reply(`⏳ Lista cheia. *${nomeConv}* adicionado à lista de espera (posição ${dados.listaEspera.length}).\n_Convidado por: ${meuNome}_`);
      }
    }

    // .lista
    else if (texto.toLowerCase() === ".lista") {
      if (!ok) return;
      await enviarLista(chat);
    }

    // .revezar Nome1 Nome2
    else if (texto.toLowerCase().startsWith(".revezar ")) {
      if (!ok) return;
      const partes = texto.slice(9).trim();
      // Divide pelo último espaço para permitir nomes compostos em Nome1
      const ultimoEspaco = partes.lastIndexOf(" ");
      if (ultimoEspaco === -1) { await msg.reply("❓ Use: .revezar NomeReserva NomeDaLista"); return; }
      const nomeReserva = partes.slice(0, ultimoEspaco).trim();
      const nomeLista   = partes.slice(ultimoEspaco + 1).trim();
      if (!nomeReserva || !nomeLista) { await msg.reply("❓ Use: .revezar NomeReserva NomeDaLista"); return; }

      const pessoaNaLista = dados.listaPrincipal.find((p) => p.nome.toLowerCase() === nomeLista.toLowerCase());
      if (!pessoaNaLista) {
        await msg.reply(`❓ *${nomeLista}* não foi encontrado(a) na lista principal.\n_A pessoa que vai revezar precisa já estar na lista._`);
        return;
      }

      const jaReserva = dados.listaReservas?.find((p) => p.nome.toLowerCase() === nomeReserva.toLowerCase());
      const jaP       = dados.listaPrincipal.find((p) => p.nome.toLowerCase() === nomeReserva.toLowerCase());
      const jaE       = dados.listaEspera.find((p) => p.nome.toLowerCase() === nomeReserva.toLowerCase());
      if (jaReserva) { await msg.reply(`⚠️ *${nomeReserva}* já é reserva de *${jaReserva.revezaCom}*.`); return; }
      if (jaP)       { await msg.reply(`⚠️ *${nomeReserva}* já está na lista principal!`); return; }
      if (jaE)       { await msg.reply(`⚠️ *${nomeReserva}* já está na lista de espera!`); return; }

      if (!dados.listaReservas) dados.listaReservas = [];
      dados.listaReservas.push({
        nome: nomeReserva,
        numero: null,
        revezaCom: pessoaNaLista.nome,
        registradoPor: numero,
        registradoPorNome: meuNome,
        adicionadoEm: new Date().toISOString(),
      });
      salvarDados(dados);
      await msg.reply(`🔄 *${nomeReserva}* adicionado(a) como reserva de *${pessoaNaLista.nome}*!\n_Registrado por: ${meuNome}_`);
    }

    // .fixos
    else if (texto.toLowerCase() === ".fixos") {
      if (!ok) return;
      const admins = CONFIG().ADMINS;
      const fixos  = CONFIG().FIXOS;
      let t = `*${CONFIG().TITULO}*\n\n`;
      t += `👑 *ADMINS* (${admins.length})\n`;
      admins.forEach((p, i) => { t += `${i + 1}. ${p.nome}\n`; });
      t += `\n🔒 *FIXOS* (${fixos.length})\n`;
      fixos.forEach((p, i) => {
        const status = p.numero ? "" : " _(sem número)_";
        t += `${i + 1}. ${p.nome}${status}\n`;
      });
      await chat.sendMessage(t);
    }

    // .remover Nome
    else if (texto.toLowerCase().startsWith(".remover ")) {
      if (!ok) return;
      const nomeBusca = texto.slice(9).trim().toLowerCase();
      if (isAdmin(numero)) {
        const iP  = dados.listaPrincipal.findIndex((p) => p.nome.toLowerCase().includes(nomeBusca));
        const iE  = dados.listaEspera.findIndex((p) => p.nome.toLowerCase().includes(nomeBusca));
        const iR  = (dados.listaReservas || []).findIndex((p) => p.nome.toLowerCase().includes(nomeBusca));
        if (iP !== -1)       { const r = dados.listaPrincipal.splice(iP, 1)[0]; salvarDados(dados); await msg.reply(`🗑️ *${r.nome}* removido da lista principal.`); }
        else if (iE !== -1)  { const r = dados.listaEspera.splice(iE, 1)[0]; salvarDados(dados); await msg.reply(`🗑️ *${r.nome}* removido da lista de espera.`); }
        else if (iR !== -1)  { const r = dados.listaReservas.splice(iR, 1)[0]; salvarDados(dados); await msg.reply(`🗑️ *${r.nome}* removido das reservas.`); }
        else { await msg.reply(`❓ Ninguém encontrado com "${nomeBusca}".`); }
      } else {
        const iE = dados.listaEspera.findIndex((p) => p.convidadoPor === numero && p.nome.toLowerCase().includes(nomeBusca));
        const iR = (dados.listaReservas || []).findIndex((p) => p.revezaCom.toLowerCase() === meuNome.toLowerCase() && p.nome.toLowerCase().includes(nomeBusca));
        if (iE !== -1)      { const r = dados.listaEspera.splice(iE, 1)[0]; salvarDados(dados); await msg.reply(`🗑️ *${r.nome}* removido da lista de espera.`); }
        else if (iR !== -1) { const r = dados.listaReservas.splice(iR, 1)[0]; salvarDados(dados); await msg.reply(`🗑️ *${r.nome}* removido das suas reservas.`); }
        else { await msg.reply(`❓ *${meuNome}*, nenhum convidado seu com o nome "${nomeBusca}".\nVocê só pode remover convidados que você mesmo adicionou ou reservas atribuídas a você.`); }
      }
    }

    // .promover Nome
    else if (texto.toLowerCase().startsWith(".promover ")) {
      if (!ok) return;
      if (!isAdmin(numero)) { await msg.reply(`⛔ *${meuNome}*, apenas administradores podem usar .promover.`); return; }
      const nomeBusca = texto.slice(10).trim().toLowerCase();
      const iE = dados.listaEspera.findIndex((p) => p.nome.toLowerCase().includes(nomeBusca));
      if (iE === -1) { await msg.reply(`❓ "${nomeBusca}" não encontrado na lista de espera.`); return; }
      if (dados.listaPrincipal.length >= CONFIG().LIMITE_LISTA_PRINCIPAL) { await msg.reply("⚠️ Lista principal cheia. Remova alguém primeiro."); return; }
      const [promovido] = dados.listaEspera.splice(iE, 1);
      dados.listaPrincipal.push({ ...promovido, convidado: true, pago: false, adicionadoEm: new Date().toISOString(), promovidoEm: new Date().toISOString() });
      salvarDados(dados);
      await msg.reply(`🎉 *${promovido.nome}* promovido para a lista de convidados!\n_⚠️ Aguardando pagamento._`);
    }

    // .pago Nome
    else if (texto.toLowerCase().startsWith(".pago ")) {
      if (!ok) return;
      if (!isAdmin(numero)) { await msg.reply(`⛔ *${meuNome}*, apenas administradores podem confirmar pagamentos.`); return; }
      const nomeBusca = texto.slice(6).trim().toLowerCase();

      // Convidado ainda na lista principal (antes do prazo)
      const iP = dados.listaPrincipal.findIndex((p) => p.convidado && p.nome.toLowerCase().includes(nomeBusca));
      if (iP !== -1) {
        if (dados.listaPrincipal[iP].pago) { await msg.reply(`✅ *${dados.listaPrincipal[iP].nome}* já está marcado como pago.`); return; }
        dados.listaPrincipal[iP].pago = true;
        dados.listaPrincipal[iP].pagamentoEm = new Date().toISOString();
        salvarDados(dados);
        await msg.reply(`💰 Pagamento de *${dados.listaPrincipal[iP].nome}* confirmado por *${meuNome}*!`);
        return;
      }

      // Convidado removido por falta de pagamento, ainda na espera
      const iE = dados.listaEspera.findIndex((p) => p.removidoPorFaltaPagamento && p.nome.toLowerCase().includes(nomeBusca));
      if (iE !== -1) {
        const pessoa = dados.listaEspera.splice(iE, 1)[0];
        if (dados.listaPrincipal.length >= CONFIG().LIMITE_LISTA_PRINCIPAL) {
          await msg.reply(`⚠️ Lista principal cheia. Não foi possível promover *${pessoa.nome}* mesmo com pagamento confirmado.\n_Use .promover quando houver vaga._`);
          dados.listaEspera.splice(iE, 0, pessoa); // devolve
          return;
        }
        const { removidoPorFaltaPagamento, ...resto } = pessoa;
        dados.listaPrincipal.push({ ...resto, convidado: true, pago: true, pagamentoEm: new Date().toISOString(), promovidoEm: new Date().toISOString() });
        salvarDados(dados);
        await msg.reply(`💰 Pagamento de *${pessoa.nome}* confirmado! Promovido de volta à lista principal por *${meuNome}*.`);
        return;
      }

      await msg.reply(`❓ Convidado "${nomeBusca}" não encontrado na lista principal nem na espera.`);
    }

    // .ajuda
    else if (texto.toLowerCase() === ".ajuda") {
      const hp = CONFIG().HORARIO_PROMOCAO;
      const hl = CONFIG().HORARIO_ENVIO_LISTA;
      const hpg = CONFIG().HORARIO_LIMITE_PAGAMENTO;
      const dias = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
      const fmt  = (h) => h ? `${dias[h.diaSemana] ?? `dia ${h.diaSemana}`} às ${String(h.hora).padStart(2,"0")}:${String(h.minuto).padStart(2,"0")}h` : `_não configurado_`;
      let r =
        `${CONFIG().TITULO}\n\n` +
        `📋 *Lista:*\n` +
        `*.entrar* — Entra na lista principal\n` +
        `*.entrar Nome* — Confirma entrada de fixo sem número\n` +
        `*.convidar Nome* — Adiciona um convidado na espera\n` +
        `*.remover Nome* — Remove seu convidado da espera ou sua reserva\n` +
        `*.sair* — Sai da lista principal ou da espera\n` +
        `*.revezar NomeReserva NomeDaLista* — Adiciona reserva para quem já está na lista\n` +
        `\n⚙️ *Outros:*\n` +
        `*.apelido NovoNome* — Define/troca seu apelido\n` +
        `*.lista* — Mostra a lista atual\n` +
        `*.fixos* — Mostra a lista de fixos e admins\n` +
        `*.ajuda* — Lista os comandos\n` +
        `\n🕐 *Horários:*\n` +
        `*Envio da lista*: ${fmt(hl)}\n` +
        `*Promoção automática*: ${fmt(hp)}\n` +
        `*Limite de pagamento*: ${fmt(hpg)}`;
      if (isAdmin(numero)) {
        r += `\n\n👑 *Admin:*\n` +
          `*.promover Nome* — Move da espera para convidados\n` +
          `*.pago Nome* — Confirma pagamento de um convidado\n` +
          `*.remover Nome* — Admins podem remover qualquer pessoa`;
      }
      await msg.reply(r);
    }
  } catch (err) {
    console.error("Erro ao processar mensagem:", err.message);
  }
});

async function enviarLista(chatOuId) {
  dados = carregarDados();

  const fixos  = dados.listaPrincipal.filter((p) => !p.convidado);
  const convs  = dados.listaPrincipal.filter((p) => p.convidado);
  const total  = dados.listaPrincipal.length;
  const limite = CONFIG().LIMITE_LISTA_PRINCIPAL;
  const vagas  = limite - total;
  const barras = Math.round((total / limite) * 10);
  const barra  = "█".repeat(barras) + "░".repeat(10 - barras);
  const pct    = Math.round((total / limite) * 100);

  const statusVagas = vagas > 0
    ? `🟢 ${vagas} vaga${vagas > 1 ? "s" : ""}`
    : `🔴 *Lotado!*`;

  const agora = new Date().toLocaleString("pt-BR", {
    weekday: "long", day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });

  let t = `*${CONFIG().TITULO}*\n`;
  t += `_📅 ${agora}_\n\n`;
  t += `✅ *CONFIRMADOS — ${total}/${limite}* (${pct}%)\n`;
  t += `\`${barra}\` ${statusVagas}\n`;

  // Seção 1 — Lista principal (fixos/regulares)
  t += `\n📋 *Lista Principal* (${fixos.length})\n`;
  if (fixos.length === 0) {
    t += `_Nenhum confirmado ainda_\n`;
  } else {
    fixos.forEach((p, i) => { t += `${i + 1}. ${p.nome}\n`; });
  }

  // Seção 2 — Convidados (promovidos da espera)
  const convsPagos    = convs.filter((p) => p.pago);
  const convsPendente = convs.filter((p) => !p.pago);
  t += `\n🎟️ *Convidados* (${convs.length})`;
  if (convs.length > 0) t += ` — 💰 ${convsPagos.length} pago${convsPagos.length !== 1 ? "s" : ""} · ⏳ ${convsPendente.length} pendente${convsPendente.length !== 1 ? "s" : ""}`;
  t += `\n`;
  if (convs.length === 0) {
    t += `_Nenhum convidado promovido_\n`;
  } else {
    convs.forEach((p, i) => {
      const conv   = p.convidadoPorNome ? ` _(conv. por ${p.convidadoPorNome})_` : "";
      const status = p.pago ? " 💰" : " ⏳";
      t += `${fixos.length + i + 1}. ${p.nome}${status}${conv}\n`;
    });
  }

  // Seção 3 — Reservas
  const reservas = dados.listaReservas || [];
  t += `\n🔄 *Reservas* (${reservas.length})\n`;
  if (reservas.length === 0) {
    t += `_Nenhuma reserva cadastrada_\n`;
  } else {
    reservas.forEach((p, i) => {
      t += `${i + 1}. ${p.nome} ↔️ ${p.revezaCom}\n`;
    });
  }

  // Seção 4 — Lista de espera
  t += `\n⏳ *Lista de Espera* (${dados.listaEspera.length})\n`;
  if (dados.listaEspera.length === 0) {
    t += `_Nenhum na espera_\n`;
  } else {
    dados.listaEspera.forEach((p, i) => {
      const conv = p.convidadoPor ? ` _(conv. por ${p.convidadoPorNome})_` : "";
      t += `${i + 1}. ${p.nome}${conv}\n`;
    });
  }

  if (typeof chatOuId === "string") {
    await client.sendMessage(chatOuId, t);
  } else {
    await chatOuId.sendMessage(t);
  }
}

async function promoverListaEspera() {
  dados = carregarDados();
  const agora = new Date().toLocaleString("pt-BR");
  console.log(`[${agora}] Promoção automática iniciada.`);

  const vagasDisponiveis = CONFIG().LIMITE_LISTA_PRINCIPAL - dados.listaPrincipal.length;
  console.log(`  → Lista principal: ${dados.listaPrincipal.length}/${CONFIG().LIMITE_LISTA_PRINCIPAL} | Vagas: ${vagasDisponiveis} | Espera: ${dados.listaEspera.length}`);

  if (vagasDisponiveis <= 0 || dados.listaEspera.length === 0) {
    console.log(`  → Nenhuma promoção realizada: ${vagasDisponiveis <= 0 ? "lista cheia" : "espera vazia"}.`);
    return;
  }

  const promovidos = dados.listaEspera.splice(0, vagasDisponiveis);
  promovidos.forEach((p) => {
    dados.listaPrincipal.push({
      ...p,
      convidado: true,
      pago: false,
      promovidoEm: new Date().toISOString(),
    });
  });
  salvarDados(dados);

  promovidos.forEach((p, i) => {
    console.log(`  → [${i + 1}] Promovido: ${p.nome}${p.convidadoPorNome ? ` (conv. por ${p.convidadoPorNome})` : ""}`);
  });
  console.log(`  → Total promovidos: ${promovidos.length}. Lista agora: ${dados.listaPrincipal.length}/${CONFIG().LIMITE_LISTA_PRINCIPAL}.`);
  await enviarLista(CONFIG().GROUP_ID);
}

async function verificarPagamentos() {
  dados = carregarDados();
  const agora = new Date().toLocaleString("pt-BR");
  console.log(`[${agora}] Verificação de pagamentos iniciada.`);

  const inadimplentes = dados.listaPrincipal.filter((p) => p.convidado && !p.pago);
  const pagantes      = dados.listaPrincipal.filter((p) => !p.convidado || p.pago);

  if (inadimplentes.length === 0) {
    console.log("  → Todos os convidados pagaram. Nenhuma remoção.");
    await client.sendMessage(CONFIG().GROUP_ID, `✅ Prazo de pagamento encerrado. Todos os convidados confirmaram!`);
    return;
  }

  // Remove inadimplentes e os manda de volta para o início da espera
  inadimplentes.forEach((p) => {
    const { convidado, pago, pagamentoEm, promovidoEm, ...resto } = p;
    dados.listaEspera.unshift({ ...resto, removidoPorFaltaPagamento: true });
    console.log(`  → Removido por falta de pagamento: ${p.nome}`);
  });

  dados.listaPrincipal = pagantes;
  salvarDados(dados);

  console.log(`  → ${inadimplentes.length} removido(s): ${inadimplentes.map((p) => p.nome).join(", ")}`);

  let aviso = `⚠️ *Prazo de pagamento encerrado!*\n\n`;
  aviso += `❌ *Removidos por não pagar:*\n`;
  inadimplentes.forEach((p, i) => { aviso += `${i + 1}. ${p.nome}\n`; });
  const vagasRestantes = CONFIG().LIMITE_LISTA_PRINCIPAL - dados.listaPrincipal.length;
  if (vagasRestantes > 0) aviso += `\n_💰 ${vagasRestantes} vaga${vagasRestantes > 1 ? "s" : ""} disponível${vagasRestantes > 1 ? "is" : ""}. Quem pagar primeiro garante a vaga._`;
  await client.sendMessage(CONFIG().GROUP_ID, aviso);
  await enviarLista(CONFIG().GROUP_ID);
}

function resetarLista() {
  dados = carregarDados();
  dados.listaPrincipal = [];
  dados.listaEspera    = [];
  salvarDados(dados);
  const agora = new Date().toLocaleString("pt-BR");
  console.log(`[${agora}] Lista resetada. Fixos, admins e apelidos mantidos.`);
}

function agendarEnvioSemanal() {
  const h   = CONFIG().HORARIO_PROMOCAO;
  const hl  = CONFIG().HORARIO_ENVIO_LISTA;
  const hpg = CONFIG().HORARIO_LIMITE_PAGAMENTO;
  const diasSemana = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

  console.log("AGENDAMENTOS CONFIGURADOS");

  // Envia lista no horário configurado e reseta
  if (hl) {
    const diaLabel  = diasSemana[hl.diaSemana] ?? `dia ${hl.diaSemana}`;
    const horaLabel = `${String(hl.hora).padStart(2, "0")}:${String(hl.minuto).padStart(2, "0")}h`;
    cron.schedule(`${hl.minuto} ${hl.hora} * * ${hl.diaSemana}`, async () => {
      const agora = new Date().toLocaleString("pt-BR");
      console.log(`[${agora}] Envio semanal da lista (${diaLabel} ${horaLabel}).`);
      try {
        resetarLista();
        await enviarLista(CONFIG().GROUP_ID);
        console.log("  → Lista resetada e enviada com sucesso!");
      }
      catch (e) { console.error("  → Erro ao enviar lista:", e.message); }
    }, { timezone: "America/Sao_Paulo" });
    console.log(`  📋 Envio da lista:    ${diaLabel} às ${horaLabel}`);
  } else {
    console.log("  📋 Envio da lista:    NÃO configurado (HORARIO_ENVIO_LISTA ausente)");
  }

  // Promove espera no horário configurado e envia lista
  if (h) {
    const diaLabel  = diasSemana[h.diaSemana] ?? `dia ${h.diaSemana}`;
    const horaLabel = `${String(h.hora).padStart(2, "0")}:${String(h.minuto).padStart(2, "0")}h`;
    cron.schedule(`${h.minuto} ${h.hora} * * ${h.diaSemana}`, async () => {
      try { await promoverListaEspera(); console.log("  → Promoção automática concluída!"); }
      catch (e) { console.error("  → Erro na promoção:", e.message); }
    }, { timezone: "America/Sao_Paulo" });
    console.log(`  🎟️  Promoção automática:  ${diaLabel} às ${horaLabel}`);
  } else {
    console.log("  🎟️  Promoção automática:  NÃO configurada (HORARIO_PROMOCAO ausente)");
  }

  // Verifica pagamentos no horário limite
  if (hpg) {
    const diaLabel  = diasSemana[hpg.diaSemana] ?? `dia ${hpg.diaSemana}`;
    const horaLabel = `${String(hpg.hora).padStart(2, "0")}:${String(hpg.minuto).padStart(2, "0")}h`;
    cron.schedule(`${hpg.minuto} ${hpg.hora} * * ${hpg.diaSemana}`, async () => {
      try { await verificarPagamentos(); console.log("  → Verificação de pagamentos concluída!"); }
      catch (e) { console.error("  → Erro na verificação de pagamentos:", e.message); }
    }, { timezone: "America/Sao_Paulo" });
    console.log(`  💰 Limite de pagamento:   ${diaLabel} às ${horaLabel}`);
  } else {
    console.log("  💰 Limite de pagamento:   NÃO configurado (HORARIO_LIMITE_PAGAMENTO ausente)");
  }
}

client.initialize();