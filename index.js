const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const cron = require("node-cron");

const ARQUIVO_DADOS = "./dados.json";

function carregarDados() {
  if (fs.existsSync(ARQUIVO_DADOS)) {
    const d = JSON.parse(fs.readFileSync(ARQUIVO_DADOS, "utf8"));
    console.log("[carregarDados] OK — GROUP_ID:", d.config?.GROUP_ID, "| ADMINS:", d.config?.ADMINS?.length, "| FIXOS:", d.config?.FIXOS?.length);
    return d;
  }
  console.warn("[carregarDados] Arquivo não encontrado, usando dados padrão.");
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
client.on("ready", () => {
  console.log("Bot pronto!");
  console.log("[ready] wid:", client.info?.wid?._serialized);
  agendarEnvioSemanal();
});
client.on("auth_failure", (msg) => { console.error("Falha na autenticacao:", msg); });
client.on("disconnected", (reason) => { console.error("[disconnected]", reason); });

client.on("message", async (msg) => {
  try {
    if (msg.from === "status@broadcast") return;
    let chat;
    try { chat = await msg.getChat(); } catch (e) { console.error("[message] Erro ao getChat:", e.message); return; }
    if (!chat.isGroup) return;

    dados = carregarDados();

    const contato = await msg.getContact();
    const numero  = contato.number;
    const nomeWpp = contato.pushname || contato.name || numero;
    const texto   = msg.body.trim();
    const ok      = chat.id._serialized === CONFIG().GROUP_ID;
    const meuNome = nomeExibicao(numero, nomeWpp);
    console.log(`[message] de=${numero} nome="${meuNome}" texto="${texto.slice(0,60)}" grupo=${ok}`);

    if (!ok) return; // ignora mensagens fora do grupo configurado

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
      const param = texto.length > 7 ? texto.slice(7).trim() : null;

      if (param) {
        const cadastro = getFixoByNome(param);
        if (!cadastro) {
          await msg.reply(`⛔ *${param}* não está na lista de fixos. Entrada não permitida.`);
          return;
        }
        const numCadastro = cadastro.numero;
        const jaP = numCadastro !== null
          ? dados.listaPrincipal.find((p) => p.numero === numCadastro)
          : dados.listaPrincipal.find((p) => p.numero === null && p.nome.toLowerCase() === cadastro.nome.toLowerCase());
        const jaE = numCadastro !== null
          ? dados.listaEspera.find((p) => p.numero === numCadastro)
          : dados.listaEspera.find((p) => p.numero === null && p.nome.toLowerCase() === cadastro.nome.toLowerCase());
        if (jaP) { await msg.reply(`✅ *${cadastro.nome}* já está na lista de fixos!`); return; }
        if (jaE) {
          const pos = (numCadastro !== null
            ? dados.listaEspera.findIndex((p) => p.numero === numCadastro)
            : dados.listaEspera.findIndex((p) => p.numero === null && p.nome.toLowerCase() === cadastro.nome.toLowerCase())) + 1;
          await msg.reply(`⏳ *${cadastro.nome}* já está na lista de espera (posição ${pos}).`);
          return;
        }
        if (dados.listaPrincipal.length < CONFIG().LIMITE_LISTA_PRINCIPAL) {
          dados.listaPrincipal.push({ nome: cadastro.nome, numero: numCadastro, adicionadoEm: new Date().toISOString(), confirmadoPor: meuNome });
          salvarDados(dados);
          await msg.reply(`✅ *${cadastro.nome}* adicionado à lista de fixos! (${dados.listaPrincipal.length}/${CONFIG().LIMITE_LISTA_PRINCIPAL})\n_Confirmado por: ${meuNome}_`);
        } else {
          dados.listaEspera.push({ nome: cadastro.nome, numero: numCadastro, adicionadoEm: new Date().toISOString(), convidadoPor: numero, convidadoPorNome: meuNome });
          salvarDados(dados);
          await msg.reply(`⏳ Lista cheia. *${cadastro.nome}* foi para a espera (posição ${dados.listaEspera.length}).\n_Confirmado por: ${meuNome}_`);
        }
        return;
      }

      const nome = meuNome;
      const jaP = dados.listaPrincipal.find((p) => p.numero === numero);
      const jaE = dados.listaEspera.find((p) => p.numero === numero);
      if (jaP) { await msg.reply(`✅ *${jaP.nome}*, você já está na lista de fixos!`); return; }
      if (jaE) {
        const pos = dados.listaEspera.findIndex((p) => p.numero === numero) + 1;
        await msg.reply(`⏳ *${jaE.nome}*, você já está na lista de espera (posição ${pos}).`);
        return;
      }
      if (isFixo(numero) && dados.listaPrincipal.length < CONFIG().LIMITE_LISTA_PRINCIPAL) {
        dados.listaPrincipal.push({ nome, numero, adicionadoEm: new Date().toISOString() });
        salvarDados(dados);
        await msg.reply(`✅ *${nome}*, você foi adicionado à lista de fixos! (${dados.listaPrincipal.length}/${CONFIG().LIMITE_LISTA_PRINCIPAL})`);
      } else {
        dados.listaEspera.push({ nome, numero, adicionadoEm: new Date().toISOString(), convidadoPor: null });
        salvarDados(dados);
        const motivo = isFixo(numero) ? "a lista de fixos está cheia" : "você não está nos fixos";
        await msg.reply(`⏳ *${nome}*, ${motivo}. Você foi para a lista de espera (posição ${dados.listaEspera.length}).`);
      }
    }

    // .sair
    else if (texto.toLowerCase() === ".sair") {
      const iP = dados.listaPrincipal.findIndex((p) => p.numero === numero);
      const iE = dados.listaEspera.findIndex((p) => p.numero === numero);
      if (iP !== -1) {
        const nome = dados.listaPrincipal[iP].nome;
        dados.listaPrincipal.splice(iP, 1);
        const reservasRemovidas = (dados.listaReservas || []).filter((r) => r.revezaCom.toLowerCase() === nome.toLowerCase());
        dados.listaReservas = (dados.listaReservas || []).filter((r) => r.revezaCom.toLowerCase() !== nome.toLowerCase());
        salvarDados(dados);
        let resposta = `👋 *${nome}*, você saiu da lista de fixos.`;
        if (reservasRemovidas.length > 0) {
          const nomes = reservasRemovidas.map((r) => `*${r.nome}*`).join(", ");
          resposta += `\n_Reserva(s) removida(s): ${nomes}_`;
        }
        await msg.reply(resposta);
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
      const nomeConv = texto.slice(10).trim();
      if (!nomeConv) { await msg.reply("❓ Use: .convidar Nome do Convidado"); return; }
      const nomeConvLower = nomeConv.toLowerCase();
      const naPrincipal = dados.listaPrincipal.find((p) => p.nome.toLowerCase() === nomeConvLower);
      const naEspera    = dados.listaEspera.find((p) => p.nome.toLowerCase() === nomeConvLower);
      if (naPrincipal) { await msg.reply(`⚠️ *${nomeConv}* já está na lista de fixos!`); return; }
      if (naEspera) { await msg.reply(`⚠️ *${nomeConv}* já está na lista de espera!${naEspera.convidadoPorNome ? ` Convidado por ${naEspera.convidadoPorNome}.` : ""}`); return; }
      if (dados.listaPrincipal.length < CONFIG().LIMITE_LISTA_PRINCIPAL) {
        dados.listaPrincipal.push({ nome: nomeConv, numero: null, adicionadoEm: new Date().toISOString(), convidadoPor: numero, convidadoPorNome: meuNome, convidado: true, pago: false });
        salvarDados(dados);
        await msg.reply(`✅ *${nomeConv}* adicionado à lista de fixos! (${dados.listaPrincipal.length}/${CONFIG().LIMITE_LISTA_PRINCIPAL})\n_Convidado por: ${meuNome} · ⏳ Aguardando pagamento_`);
      } else {
        dados.listaEspera.push({ nome: nomeConv, numero: null, adicionadoEm: new Date().toISOString(), convidadoPor: numero, convidadoPorNome: meuNome });
        salvarDados(dados);
        await msg.reply(`⏳ Lista cheia. *${nomeConv}* adicionado à lista de espera (posição ${dados.listaEspera.length}).\n_Convidado por: ${meuNome}_`);
      }
    }

    // .lista
    else if (texto.toLowerCase() === ".lista") {
      await enviarLista(chat);
    }

    // .revezar Nome1 Nome2
    else if (texto.toLowerCase().startsWith(".revezar ")) {
      const partes = texto.slice(9).trim();
      // Divide pelo último espaço para permitir nomes compostos em Nome1
      const ultimoEspaco = partes.lastIndexOf(" ");
      if (ultimoEspaco === -1) { await msg.reply("❓ Use: .revezar NomeReserva NomeDaLista"); return; }
      const nomeReserva = partes.slice(0, ultimoEspaco).trim();
      const nomeLista   = partes.slice(ultimoEspaco + 1).trim();
      if (!nomeReserva || !nomeLista) { await msg.reply("❓ Use: .revezar NomeReserva NomeDaLista"); return; }

      const pessoaNaLista = dados.listaPrincipal.find((p) => p.nome.toLowerCase() === nomeLista.toLowerCase());
      if (!pessoaNaLista) {
        await msg.reply(`❓ *${nomeLista}* não foi encontrado(a) na lista de fixos.\n_A pessoa que vai revezar precisa já estar na lista._`);
        return;
      }

      const jaReserva = dados.listaReservas?.find((p) => p.nome.toLowerCase() === nomeReserva.toLowerCase());
      const jaP       = dados.listaPrincipal.find((p) => p.nome.toLowerCase() === nomeReserva.toLowerCase());
      const jaE       = dados.listaEspera.find((p) => p.nome.toLowerCase() === nomeReserva.toLowerCase());
      if (jaReserva) { await msg.reply(`⚠️ *${nomeReserva}* já é reserva de *${jaReserva.revezaCom}*.`); return; }
      if (jaP)       { await msg.reply(`⚠️ *${nomeReserva}* já está na lista de fixos!`); return; }
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
      const nomeBusca = texto.slice(9).trim().toLowerCase();
      if (isAdmin(numero)) {
        const iP  = dados.listaPrincipal.findIndex((p) => p.nome.toLowerCase().includes(nomeBusca));
        const iE  = dados.listaEspera.findIndex((p) => p.nome.toLowerCase().includes(nomeBusca));
        const iR  = (dados.listaReservas || []).findIndex((p) => p.nome.toLowerCase().includes(nomeBusca));
        if (iP !== -1)       { const r = dados.listaPrincipal.splice(iP, 1)[0]; salvarDados(dados); await msg.reply(`🗑️ *${r.nome}* removido da lista de fixos.`); }
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
      if (!isAdmin(numero)) { await msg.reply(`⛔ *${meuNome}*, apenas administradores podem usar .promover.`); return; }
      const nomeBusca = texto.slice(10).trim().toLowerCase();
      const iE = dados.listaEspera.findIndex((p) => p.nome.toLowerCase().includes(nomeBusca));
      if (iE === -1) { await msg.reply(`❓ "${nomeBusca}" não encontrado na lista de espera.`); return; }
      if (dados.listaPrincipal.length >= CONFIG().LIMITE_LISTA_PRINCIPAL) { await msg.reply("⚠️ Lista de fixos cheia. Remova alguém primeiro."); return; }
      const [promovido] = dados.listaEspera.splice(iE, 1);
      dados.listaPrincipal.push({ ...promovido, convidado: true, pago: false, adicionadoEm: new Date().toISOString(), promovidoEm: new Date().toISOString() });
      salvarDados(dados);
      await msg.reply(`🎉 *${promovido.nome}* promovido para a lista de convidados!\n_⚠️ Aguardando pagamento._`);
    }

    // .pago Nome
    else if (texto.toLowerCase().startsWith(".pago ")) {
      if (!isAdmin(numero)) { await msg.reply(`⛔ *${meuNome}*, apenas administradores podem confirmar pagamentos.`); return; }
      const nomeBusca = texto.slice(6).trim().toLowerCase();

      // Convidado ainda na lista de fixos (antes do prazo)
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
          await msg.reply(`⚠️ Lista de fixos cheia. Não foi possível promover *${pessoa.nome}* mesmo com pagamento confirmado.\n_Use .promover quando houver vaga._`);
          dados.listaEspera.splice(iE, 0, pessoa); // devolve
          return;
        }
        const { removidoPorFaltaPagamento, ...resto } = pessoa;
        dados.listaPrincipal.push({ ...resto, convidado: true, pago: true, pagamentoEm: new Date().toISOString(), promovidoEm: new Date().toISOString() });
        salvarDados(dados);
        await msg.reply(`💰 Pagamento de *${pessoa.nome}* confirmado! Promovido de volta à lista de fixos por *${meuNome}*.`);
        return;
      }

      await msg.reply(`❓ Convidado "${nomeBusca}" não encontrado na lista de fixos nem na espera.`);
    }

    // Menção ao bot
    else if (msg.mentionedIds?.length > 0) {
      const botNum = client.info?.wid?.user;
      const contacts = await msg.getMentions();
      const foiMencionado = contacts.some((c) => c.number === botNum);
      console.log(`[mention] mentionedIds:`, msg.mentionedIds, `botNum:`, botNum, `foiMencionado:`, foiMencionado);
      if (!foiMencionado) return;
      console.log(`[${new Date().toLocaleString("pt-BR")}] Bot mencionado por ${meuNome} (${numero})`);
      const listaAberta = listaEstaAberta();
      const statusLista = listaAberta
        ? ` *Há uma lista em aberto!* Digite *.lista* para ver ou *.entrar* para participar.`
        : ` A lista do racha não está aberta no momento.`;
      await msg.reply(`🦉 Olá, *${meuNome}*! Sou a *Corujinha*, bot do ${CONFIG().TITULO}!\n\n${statusLista}\n\nSe precisar de ajuda, digite *.ajuda* 😊`);
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
        `📋 *LISTA:*\n` +
        `*.entrar* — Entra na lista (fixo ou convidado)\n` +
        `*.entrar Nome* — Adiciona o fixo com esse nome na lista\n` +
        `*.convidar Nome* — Adiciona um convidado\n` +
        `*.remover Nome* — Remove seu convidado ou seu reserva\n` +
        `*.sair* — Sai da lista\n` +
        `*.revezar NomeDoReserva NomePresenteNaLista* — Adiciona reserva\n` +
        `\n\n⚙️ *OUTROS:*\n` +
        `*.apelido NovoNome* — Define ou troca seu apelido\n` +
        `*.lista* — Mostra a lista atual\n` +
        `*.fixos* — Mostra a lista de fixos e admins\n` +
        `*.ajuda* — Lista os comandos\n` +
        `\n\n🕐 *HORÁRIOS:*\n` +
        `*Abertura da lista*: ${fmt(hl)}\n` +
        `*Sobe os convidados*: ${fmt(hp)}\n` +
        `*Limite de pagamento dos convidados*: ${fmt(hpg)}`;
      if (isAdmin(numero)) {
        r += `\n\n👑 *Admin:*\n` +
          `*.promover Nome* — Move da espera para convidados\n` +
          `*.pago Nome* — Confirma pagamento de um convidado\n` +
          `*.remover Nome* — Admins podem remover qualquer pessoa`;
      }
      await msg.reply(r);
    }
  } catch (err) {
    console.error("[message] Erro ao processar:", err.message, err.stack);
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

  const agoraSP = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const diasAteProxSexta = (5 - agoraSP.getDay() + 7) % 7 || 7;
  const proxSexta = new Date(agoraSP);
  proxSexta.setDate(agoraSP.getDate() + diasAteProxSexta);
  const dataSexta = proxSexta.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Sao_Paulo" });

  let t = `*${CONFIG().TITULO}*\n`;
  t += `_📅 Sexta Feira, ${dataSexta} - 19h às 22h_\n\n`;
  t += `\`${barra}\` ${total}/${limite} (${pct}%)\n`;

  // Seção 1 — Lista de fixos (fixos/regulares)
  t += `\n *FIXOS* (${fixos.length})\n`;
  if (fixos.length === 0) {
    t += `_Nenhum confirmado ainda_\n`;
  } else {
    fixos.forEach((p, i) => { t += `${i + 1}. ${p.nome}\n`; });
  }

  // Seção 2 — Convidados (promovidos da espera)
  const convsPagos    = convs.filter((p) => p.pago);
  const convsPendente = convs.filter((p) => !p.pago);
  t += `\n *CONVIDADOS* (${convs.length})`;
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
  t += `\n *RESERVAS* (${reservas.length})\n`;
  if (reservas.length === 0) {
    t += `_Nenhuma reserva cadastrada_\n`;
  } else {
    reservas.forEach((p, i) => {
      t += `${i + 1}. ${p.nome} <-> ${p.revezaCom}\n`;
    });
  }

  // Seção 4 — Lista de espera
  t += `\n *LISTA DE ESPERA* (${dados.listaEspera.length})\n`;
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
  console.log(`  → Lista de fixos: ${dados.listaPrincipal.length}/${CONFIG().LIMITE_LISTA_PRINCIPAL} | Vagas: ${vagasDisponiveis} | Espera: ${dados.listaEspera.length}`);

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
  dados.listaReservas  = [];
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
      try { await promoverListaEspera(); console.log("  → Sobe os convidados concluída!"); }
      catch (e) { console.error("  → Erro na promoção:", e.message); }
    }, { timezone: "America/Sao_Paulo" });
    console.log(`  🎟️  Sobe os convidados:  ${diaLabel} às ${horaLabel}`);
  } else {
    console.log("  🎟️  Sobe os convidados:  NÃO configurada (HORARIO_PROMOCAO ausente)");
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