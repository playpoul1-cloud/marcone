// ============================================================
// TROPA DO GALINHA - ANTI NUKE INTEGRADO
// discord.js v14
//
// SISTEMAS:
// - Anti-Nuke
// - Anti-Spam
// - Timeout 1m -> 5m -> Ban
// - Anti-Bot
// - Bots existentes protegidos
// - Loritta protegida
// - Ticket King protegido
// - Anti-Webhook por mensagem
// - Anti-Webhook por criação
// - Audit Log para descobrir criador do webhook
// - Exclusão de webhook não autorizado
// - Logs
// - Backup de cargos
// - Backup de canais
// - Restauração de cargos/canais apagados
//
// ============================================================

const {
    Client,
    GatewayIntentBits,
    Partials,
    PermissionsBitField,
    AuditLogEvent,
    EmbedBuilder,
    ChannelType
} = require("discord.js");

const fs = require("fs");
const path = require("path");

// ============================================================
// CONFIGURAÇÃO
// ============================================================

const TOKEN = process.env.TOKEN;

if (!TOKEN) {
    console.error("❌ A variável TOKEN não foi encontrada.");
    process.exit(1);
}

// ------------------------------------------------------------
// SERVIDOR PROTEGIDO
// ------------------------------------------------------------

const PROTECTED_GUILD_ID =
    process.env.PROTECTED_GUILD_ID || "";

// ------------------------------------------------------------
// CANAL DE LOG
//
//
// Coloque o ID do canal anti-nuke-logs no Railway:
// LOG_CHANNEL_ID=123456789
// ------------------------------------------------------------

const LOG_CHANNEL_ID =
    process.env.LOG_CHANNEL_ID || "";

// ============================================================
// USUÁRIOS CONFIÁVEIS
// ============================================================
//
// IDs separados por vírgula:
//
// TRUSTED_USER_IDS=123,456,789
//
// Essas pessoas NÃO serão punidas pelo Anti-Nuke.
// ============================================================

const TRUSTED_USER_IDS = new Set(
    (process.env.TRUSTED_USER_IDS || "")
        .split(",")
        .map(id => id.trim())
        .filter(Boolean)
);

// ============================================================
// BOTS AUTORIZADOS
// ============================================================
//
// Você pode colocar IDs aqui:
//
// AUTHORIZED_BOT_IDS=123456789,987654321
//
// ALÉM DISSO:
//
// Loritta
// Ticket King
//
// ficam protegidos pelo nome.
//
// E MAIS IMPORTANTE:
//
// TODOS OS BOTS QUE JÁ ESTIVEREM NO SERVIDOR
// QUANDO O BOT INICIAR SERÃO PROTEGIDOS.
//
// Isso evita o problema que aconteceu anteriormente.
// ============================================================

const AUTHORIZED_BOT_IDS = new Set(
    (process.env.AUTHORIZED_BOT_IDS || "")
        .split(",")
        .map(id => id.trim())
        .filter(Boolean)
);

// Nomes de bots conhecidos/protegidos.
const AUTHORIZED_BOT_NAMES = new Set([
    "loritta",
    "ticket king"
]);

// ============================================================
// CONFIGURAÇÕES ANTI-SPAM
// ============================================================

const SPAM_MESSAGE_LIMIT = 5;
const SPAM_WINDOW_MS = 10_000;

const TIMEOUT_1_MS = 60_000;       // 1 minuto
const TIMEOUT_2_MS = 5 * 60_000;  // 5 minutos

// Depois do terceiro ataque de spam:
// BAN.

// ============================================================
// CONFIGURAÇÕES ANTI-NUKE
// ============================================================

const NUKE_WINDOW_MS = 10_000;

// Quantidade de ações destrutivas dentro da janela.
const NUKE_LIMIT = 3;

// ============================================================
// WEBHOOK
// ============================================================

// Webhooks existentes ao iniciar serão preservados.
const PRESERVE_EXISTING_WEBHOOKS = true;

// Webhooks criados depois do início serão analisados.
const BLOCK_UNAUTHORIZED_WEBHOOKS = true;

// ============================================================
// CLIENT
// ============================================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],

    partials: [
        Partials.Channel,
        Partials.GuildMember,
        Partials.User,
        Partials.Message
    ]
});

// ============================================================
// MAPS / CACHE
// ============================================================

// Bots autorizados em memória.
const authorizedBotCache = new Set(
    [...AUTHORIZED_BOT_IDS]
);

// Webhooks autorizados.
const authorizedWebhookCache = new Set();

// Webhooks sendo processados.
const webhookProcessing = new Set();

// Spam por usuário.
const spamCache = new Map();

// Quantidade de infrações de spam.
const spamOffenses = new Map();

// Anti-Nuke por usuário.
const nukeActions = new Map();

// Backup de cargos.
const roleBackup = new Map();

// Backup de canais.
const channelBackup = new Map();

// ============================================================
// ARQUIVO DE BACKUP
// ============================================================

const DATA_DIR = path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, {
        recursive: true
    });
}

const BACKUP_FILE = path.join(
    DATA_DIR,
    "server-backup.json"
);

// ============================================================
// FUNÇÕES AUXILIARES
// ============================================================

function isTrustedUser(userId) {

    if (!userId) {
        return false;
    }

    if (userId === client.user?.id) {
        return true;
    }

    return TRUSTED_USER_IDS.has(userId);
}

// ------------------------------------------------------------

function normalizeName(name) {

    return String(name || "")
        .trim()
        .toLowerCase();
}

// ------------------------------------------------------------

function isAuthorizedBot(user) {

    if (!user) {
        return false;
    }

    if (authorizedBotCache.has(user.id)) {
        return true;
    }

    if (AUTHORIZED_BOT_IDS.has(user.id)) {
        return true;
    }

    const username = normalizeName(user.username);
    const globalName = normalizeName(user.globalName);

    if (
        AUTHORIZED_BOT_NAMES.has(username) ||
        AUTHORIZED_BOT_NAMES.has(globalName)
    ) {
        return true;
    }

    return false;
}

// ------------------------------------------------------------

function rememberAuthorizedBot(user) {

    if (!user) {
        return;
    }

    authorizedBotCache.add(user.id);
}

// ============================================================
// LOG
// ============================================================

async function sendLog(
    guild,
    title,
    description,
    type = "info"
) {

    try {

        if (!guild) {
            return;
        }

        let channel = null;

        if (LOG_CHANNEL_ID) {

            channel =
                guild.channels.cache.get(
                    LOG_CHANNEL_ID
                );
        }

        // Se não encontrou o canal configurado,
        // procura por anti-nuke-logs.

        if (!channel) {

            channel =
                guild.channels.cache.find(
                    c =>
                        c.isTextBased() &&
                        normalizeName(c.name) ===
                        "anti-nuke-logs"
                );
        }

        if (!channel) {
            return;
        }

        let color = 0x5865F2;

        if (type === "danger") {
            color = 0xED4245;
        }

        if (type === "warning") {
            color = 0xFEE75C;
        }

        if (type === "success") {
            color = 0x57F287;
        }

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(color)
            .setTimestamp();

        await channel.send({
            embeds: [embed]
        });

    } catch (error) {

        console.error(
            "Erro ao enviar log:",
            error
        );
    }
}

// ============================================================
// AUDIT LOG
// ============================================================

async function getRecentAuditEntry(
    guild,
    action,
    targetId = null
) {

    try {

        const logs =
            await guild.fetchAuditLogs({
                type: action,
                limit: 10
            });

        const now = Date.now();

        for (const entry of logs.entries.values()) {

            const age =
                now -
                entry.createdTimestamp;

            if (age > 15_000) {
                continue;
            }

            if (
                targetId &&
                entry.targetId !== targetId
            ) {
                continue;
            }

            return entry;
        }

        return null;

    } catch (error) {

        console.error(
            "Erro ao consultar Audit Log:",
            error
        );

        return null;
    }
}

// ============================================================
// ANTI-BOT
// ============================================================

client.on(
    "guildMemberAdd",
    async member => {

        try {

            if (!member.guild) {
                return;
            }

            if (
                PROTECTED_GUILD_ID &&
                member.guild.id !== PROTECTED_GUILD_ID
            ) {
                return;
            }

            // Não é bot.
            if (!member.user.bot) {
                return;
            }

            // =================================================
            // REGRA MAIS IMPORTANTE:
            //
            // Se o bot já estava no servidor quando iniciamos,
            // ele foi colocado no cache de autorizados.
            //
            // Se estiver autorizado, NÃO fazer nada.
            // =================================================

            if (isAuthorizedBot(member.user)) {

                rememberAuthorizedBot(
                    member.user
                );

                await sendLog(
                    member.guild,
                    "🤖 BOT AUTORIZADO",
                    `O bot **${member.user.username}** foi autorizado e não será punido.\n\n` +
                    `**ID:** \`${member.user.id}\``,
                    "success"
                );

                return;
            }

            // =================================================
            // BOT DESCONHECIDO
            // =================================================

            await sendLog(
                member.guild,
                "🚨 BOT NÃO AUTORIZADO",
                `Detectei um bot que não está na lista de autorizados.\n\n` +
                `**Bot:** ${member.user}\n` +
                `**Nome:** ${member.user.username}\n` +
                `**ID:** \`${member.user.id}\`\n\n` +
                `O bot será removido.`,
                "danger"
            );

            // Banir o bot.
            if (
                member.bannable &&
                member.guild.members.me.permissions.has(
                    PermissionsBitField.Flags.BanMembers
                )
            ) {

                await member.ban({
                    reason:
                        "Anti-Bot: bot não autorizado"
                });

                await sendLog(
                    member.guild,
                    "🔨 BOT BANIDO",
                    `O bot **${member.user.username}** foi banido por não estar autorizado.\n\n` +
                    `**ID:** \`${member.user.id}\``,
                    "danger"
                );
            }

        } catch (error) {

            console.error(
                "Erro Anti-Bot:",
                error
            );
        }
    }
);

// ============================================================
// PROTEGER BOTS EXISTENTES
// ============================================================

async function initializeAuthorizedBots(guild) {

    try {

        await guild.members.fetch();

        let count = 0;

        for (
            const member of
            guild.members.cache.values()
        ) {

            if (!member.user.bot) {
                continue;
            }

            // =================================================
            // TODO BOT EXISTENTE É PROTEGIDO.
            //
            // Isso corrige o problema da Loritta/Ticket King.
            // =================================================

            rememberAuthorizedBot(
                member.user
            );

            count++;
        }

        console.log(
            `🤖 ${count} bots existentes protegidos.`
        );

        await sendLog(
            guild,
            "🛡️ BOTS EXISTENTES PROTEGIDOS",
            `O Anti-Nuke iniciou e protegeu **${count} bots** que já estavam no servidor.\n\n` +
            `Bots existentes não serão considerados invasores.`,
            "success"
        );

    } catch (error) {

        console.error(
            "Erro ao proteger bots existentes:",
            error
        );
    }
}

// ============================================================
// ANTI-SPAM
// ============================================================

client.on(
    "messageCreate",
    async message => {

        try {

            if (!message.guild) {
                return;
            }

            if (message.author.bot) {
                return;
            }

            if (
                PROTECTED_GUILD_ID &&
                message.guild.id !== PROTECTED_GUILD_ID
            ) {
                return;
            }

            if (
                isTrustedUser(
                    message.author.id
                )
            ) {
                return;
            }

            const userId =
                message.author.id;

            const now = Date.now();

            let messages =
                spamCache.get(userId) || [];

            messages =
                messages.filter(
                    timestamp =>
                        now - timestamp <
                        SPAM_WINDOW_MS
                );

            messages.push(now);

            spamCache.set(
                userId,
                messages
            );

            if (
                messages.length <
                SPAM_MESSAGE_LIMIT
            ) {
                return;
            }

            // Limpa a janela.
            spamCache.set(
                userId,
                []
            );

            let offense =
                spamOffenses.get(
                    userId
                ) || 0;

            offense++;

            spamOffenses.set(
                userId,
                offense
            );

            // =================================================
            // 1ª OCORRÊNCIA
            // =================================================

            if (offense === 1) {

                try {

                    await message.member.timeout(
                        TIMEOUT_1_MS,
                        "Anti-Spam: 5 mensagens em 10 segundos"
                    );

                    await sendLog(
                        message.guild,
                        "💬 ANTI-SPAM",
                        `**${message.author.tag}** atingiu 5 mensagens em 10 segundos.\n\n` +
                        `**Ocorrência:** 1/3\n` +
                        `**Punição:** Timeout de 1 minuto.`,
                        "warning"
                    );

                } catch (error) {

                    console.error(
                        "Erro no timeout 1:",
                        error
                    );
                }

                return;
            }

            // =================================================
            // 2ª OCORRÊNCIA
            // =================================================

            if (offense === 2) {

                try {

                    await message.member.timeout(
                        TIMEOUT_2_MS,
                        "Anti-Spam: segunda ocorrência"
                    );

                    await sendLog(
                        message.guild,
                        "💬 ANTI-SPAM",
                        `**${message.author.tag}** repetiu o spam.\n\n` +
                        `**Ocorrência:** 2/3\n` +
                        `**Punição:** Timeout de 5 minutos.`,
                        "warning"
                    );

                } catch (error) {

                    console.error(
                        "Erro no timeout 2:",
                        error
                    );
                }

                return;
            }

            // =================================================
            // 3ª OCORRÊNCIA
            // =================================================

            if (offense >= 3) {

                try {

                    if (
                        message.member.bannable
                    ) {

                        await message.member.ban({
                            reason:
                                "Anti-Spam: terceira ocorrência"
                        });

                        await sendLog(
                            message.guild,
                            "🔨 ANTI-SPAM - BAN",
                            `**${message.author.tag}** atingiu a terceira ocorrência de spam.\n\n` +
                            `**Ocorrência:** 3/3\n` +
                            `**Punição:** BAN.`,
                            "danger"
                        );
                    }

                } catch (error) {

                    console.error(
                        "Erro ao banir por spam:",
                        error
                    );
                }
            }

        } catch (error) {

            console.error(
                "Erro Anti-Spam:",
                error
            );
        }
    }
);

// ============================================================
// ANTI-WEBHOOK POR MENSAGEM
// ============================================================

client.on(
    "messageCreate",
    async message => {

        try {

            if (!message.guild) {
                return;
            }

            if (!message.webhookId) {
                return;
            }

            if (
                authorizedWebhookCache.has(
                    message.webhookId
                )
            ) {
                return;
            }

            // Se o webhook não estiver autorizado,
            // apagamos a mensagem.

            try {

                await message.delete(
                    "Anti-Webhook: webhook não autorizado"
                );

                await sendLog(
                    message.guild,
                    "🪝 MENSAGEM DE WEBHOOK BLOQUEADA",
                    `Uma mensagem enviada por um webhook não autorizado foi apagada.\n\n` +
                    `**Webhook ID:** \`${message.webhookId}\`\n` +
                    `**Canal:** ${message.channel}`,
                    "danger"
                );

            } catch (error) {

                console.error(
                    "Erro ao apagar mensagem de webhook:",
                    error
                );
            }

        } catch (error) {

            console.error(
                "Erro Anti-Webhook por mensagem:",
                error
            );
        }
    }
);

// ============================================================
// VERIFICAR WEBHOOK AUTORIZADO
// ============================================================

function isAuthorizedWebhook(
    webhookId
) {

    if (!webhookId) {
        return false;
    }

    return authorizedWebhookCache.has(
        webhookId
    );
}

// ============================================================
// APAGAR WEBHOOK NÃO AUTORIZADO
// ============================================================

async function deleteUnauthorizedWebhook(
    guild,
    webhook,
    executorId = null
) {

    try {

        if (!webhook) {
            return false;
        }

        if (
            isAuthorizedWebhook(
                webhook.id
            )
        ) {
            return false;
        }

        if (
            webhookProcessing.has(
                webhook.id
            )
        ) {
            return false;
        }

        webhookProcessing.add(
            webhook.id
        );

        try {

            await webhook.delete(
                "Anti-Nuke: Webhook não autorizado"
            );

            await sendLog(
                guild,
                "🪝 WEBHOOK BLOQUEADO",
                `Um Webhook não autorizado foi excluído automaticamente.\n\n` +
                `**Nome:** ${webhook.name || "Sem nome"}\n` +
                `**Webhook ID:** \`${webhook.id}\`\n` +
                `**Criador:** ${
                    executorId
                        ? `<@${executorId}>`
                        : "Não identificado"
                }`,
                "danger"
            );

            // =================================================
            // SE SABEMOS QUEM CRIOU,
            // PUNIR O CRIADOR.
            // =================================================

            if (
                executorId &&
                !isTrustedUser(executorId) &&
                executorId !== client.user.id
            ) {

                try {

                    const member =
                        await guild.members.fetch(
                            executorId
                        );

                    if (
                        member &&
                        member.bannable
                    ) {

                        await member.ban({
                            reason:
                                "Anti-Nuke: criação de webhook não autorizado"
                        });

                        await sendLog(
                            guild,
                            "🔨 CRIADOR DE WEBHOOK BANIDO",
                            `O responsável pela criação do webhook não autorizado foi banido.\n\n` +
                            `**Usuário:** ${member.user.tag}\n` +
                            `**ID:** \`${member.id}\``,
                            "danger"
                        );
                    }

                } catch (error) {

                    console.error(
                        "Erro ao punir criador do webhook:",
                        error
                    );
                }
            }

            return true;

        } catch (error) {

            console.error(
                "Erro ao apagar Webhook não autorizado:",
                error
            );

            await sendLog(
                guild,
                "⚠️ WEBHOOK NÃO BLOQUEADO",
                `Detectei um Webhook não autorizado, mas não consegui removê-lo.\n\n` +
                `**Nome:** ${webhook.name || "Sem nome"}\n` +
                `**ID:** \`${webhook.id}\`\n` +
                `**Criador:** ${
                    executorId
                        ? `<@${executorId}>`
                        : "Não identificado"
                }`,
                "warning"
            );

            return false;

        } finally {

            setTimeout(
                () => {
                    webhookProcessing.delete(
                        webhook.id
                    );
                },
                5000
            );
        }

    } catch (error) {

        console.error(
            "Erro no sistema Anti-Webhook:",
            error
        );

        return false;
    }
}

// ============================================================
// INICIALIZAR WEBHOOKS
// ============================================================

async function initializeWebhooks(
    guild
) {

    try {

        const webhooks =
            await guild.fetchWebhooks();

        console.log(
            `🪝 Webhooks encontrados: ${webhooks.size}`
        );

        for (
            const webhook of
            webhooks.values()
        ) {

            // =================================================
            // CORREÇÃO IMPORTANTE:
            //
            // WEBHOOKS QUE JÁ EXISTIAM ANTES DO BOT INICIAR
            // SÃO PRESERVADOS.
            //
            // Não apagar webhook de Ticket King,
            // Loritta ou qualquer outro bot existente.
            // =================================================

            if (
                PRESERVE_EXISTING_WEBHOOKS
            ) {

                authorizedWebhookCache.add(
                    webhook.id
                );

                continue;
            }

            if (
                BLOCK_UNAUTHORIZED_WEBHOOKS
            ) {

                await deleteUnauthorizedWebhook(
                    guild,
                    webhook,
                    null
                );
            }
        }

        await sendLog(
            guild,
            "🪝 WEBHOOKS INICIALIZADOS",
            `Foram encontrados **${webhooks.size} webhooks**.\n\n` +
            `Webhooks que já existiam antes da inicialização foram preservados.`,
            "success"
        );

    } catch (error) {

        console.error(
            "Erro ao carregar Webhooks:",
            error
        );
    }
}

// ============================================================
// EVENTO WEBHOOKS UPDATE
// ============================================================

client.on(
    "webhooksUpdate",
    async channel => {

        try {

            if (!channel.guild) {
                return;
            }

            const guild =
                channel.guild;

            // Pequeno atraso para o Audit Log
            // receber a entrada.

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        1000
                    )
            );

            const webhooks =
                await guild.fetchWebhooks();

            // =================================================
            // DESCOBRIR O CRIADOR PELO AUDIT LOG
            // =================================================

            const entry =
                await getRecentAuditEntry(
                    guild,
                    AuditLogEvent.WebhookCreate
                );

            let executorId =
                entry?.executorId || null;

            // =================================================
            // SE O CRIADOR É CONFIÁVEL:
            // AUTORIZAR O WEBHOOK.
            // =================================================

            if (
                executorId &&
                (
                    isTrustedUser(
                        executorId
                    ) ||
                    executorId === client.user.id
                )
            ) {

                for (
                    const webhook of
                    webhooks.values()
                ) {

                    if (
                        entry.targetId ===
                        webhook.id
                    ) {

                        authorizedWebhookCache.add(
                            webhook.id
                        );

                        await sendLog(
                            guild,
                            "🪝 WEBHOOK AUTORIZADO",
                            `Um webhook foi criado por um usuário autorizado.\n\n` +
                            `**Nome:** ${webhook.name || "Sem nome"}\n` +
                            `**ID:** \`${webhook.id}\`\n` +
                            `**Criador:** <@${executorId}>`,
                            "success"
                        );
                    }
                }

                return;
            }

            // =================================================
            // SE CRIADOR NÃO AUTORIZADO:
            // APAGAR O WEBHOOK.
            // =================================================

            if (
                BLOCK_UNAUTHORIZED_WEBHOOKS
            ) {

                for (
                    const webhook of
                    webhooks.values()
                ) {

                    // Se já autorizado, ignorar.
                    if (
                        authorizedWebhookCache.has(
                            webhook.id
                        )
                    ) {
                        continue;
                    }

                    // Se encontramos o alvo exato,
                    // bloqueamos.

                    if (
                        entry &&
                        entry.targetId ===
                        webhook.id
                    ) {

                        await deleteUnauthorizedWebhook(
                            guild,
                            webhook,
                            executorId
                        );
                    }
                }
            }

        } catch (error) {

            console.error(
                "Erro em webhooksUpdate:",
                error
            );
        }
    }
);

// ============================================================
// BACKUP DE CARGOS
// ============================================================

function createRoleBackup(
    guild
) {

    const roles = [];

    for (
        const role of
        guild.roles.cache.values()
    ) {

        if (role.managed) {
            continue;
        }

        roles.push({
            id: role.id,
            name: role.name,
            color: role.color,
            hoist: role.hoist,
            position: role.position,
            permissions:
                role.permissions.bitfield.toString(),
            mentionable:
                role.mentionable
        });
    }

    roleBackup.set(
        guild.id,
        roles
    );

    saveBackupFile(
        guild
    );
}

// ============================================================
// BACKUP DE CANAIS
// ============================================================

function createChannelBackup(
    guild
) {

    const channels = [];

    for (
        const channel of
        guild.channels.cache.values()
    ) {

        if (!channel.guild) {
            continue;
        }

        channels.push({
            id: channel.id,
            name: channel.name,
            type: channel.type,
            parentId:
                channel.parentId || null,
            position:
                channel.rawPosition ?? 0,
            topic:
                "topic" in channel
                    ? channel.topic
                    : null,
            nsfw:
                "nsfw" in channel
                    ? channel.nsfw
                    : false,
            rateLimitPerUser:
                "rateLimitPerUser" in channel
                    ? channel.rateLimitPerUser
                    : 0
        });
    }

    channelBackup.set(
        guild.id,
        channels
    );

    saveBackupFile(
        guild
    );
}

// ============================================================
// SALVAR BACKUP
// ============================================================

function saveBackupFile(
    guild
) {

    try {

        const data = {
            guildId: guild.id,
            updatedAt: Date.now(),
            roles:
                roleBackup.get(
                    guild.id
                ) || [],
            channels:
                channelBackup.get(
                    guild.id
                ) || []
        };

        fs.writeFileSync(
            BACKUP_FILE,
            JSON.stringify(
                data,
                null,
                2
            )
        );

    } catch (error) {

        console.error(
            "Erro ao salvar backup:",
            error
        );
    }
}

// ============================================================
// CARREGAR BACKUP
// ============================================================

function loadBackupFile(
    guild
) {

    try {

        if (
            !fs.existsSync(
                BACKUP_FILE
            )
        ) {
            return;
        }

        const data =
            JSON.parse(
                fs.readFileSync(
                    BACKUP_FILE,
                    "utf8"
                )
            );

        if (
            data.guildId !==
            guild.id
        ) {
            return;
        }

        if (
            Array.isArray(
                data.roles
            )
        ) {

            roleBackup.set(
                guild.id,
                data.roles
            );
        }

        if (
            Array.isArray(
                data.channels
            )
        ) {

            channelBackup.set(
                guild.id,
                data.channels
            );
        }

    } catch (error) {

        console.error(
            "Erro ao carregar backup:",
            error
        );
    }
}

// ============================================================
// ANTI-NUKE
// ============================================================

function registerNukeAction(
    guild,
    userId
) {

    if (!userId) {
        return 0;
    }

    if (
        isTrustedUser(userId)
    ) {
        return 0;
    }

    const key =
        `${guild.id}:${userId}`;

    const now =
        Date.now();

    let actions =
        nukeActions.get(key) || [];

    actions =
        actions.filter(
            timestamp =>
                now - timestamp <
                NUKE_WINDOW_MS
        );

    actions.push(now);

    nukeActions.set(
        key,
        actions
    );

    return actions.length;
}

// ============================================================
// PUNIR USUÁRIO NUKE
// ============================================================

async function punishNukeUser(
    guild,
    userId,
    reason
) {

    try {

        if (!userId) {
            return;
        }

        if (
            isTrustedUser(userId)
        ) {
            return;
        }

        if (
            userId ===
            client.user.id
        ) {
            return;
        }

        const member =
            await guild.members.fetch(
                userId
            ).catch(
                () => null
            );

        if (!member) {
            return;
        }

        if (
            !member.bannable
        ) {

            await sendLog(
                guild,
                "⚠️ NÃO FOI POSSÍVEL BANIR",
                `Detectei comportamento de Anti-Nuke, mas não consigo banir o responsável.\n\n` +
                `**Usuário:** <@${userId}>\n` +
                `**Motivo:** ${reason}`,
                "warning"
            );

            return;
        }

        await member.ban({
            reason:
                `Anti-Nuke: ${reason}`
        });

        await sendLog(
            guild,
            "🛡️ ANTI-NUKE - USUÁRIO BANIDO",
            `Um usuário realizou ações destrutivas em excesso e foi banido.\n\n` +
            `**Usuário:** <@${userId}>\n` +
            `**ID:** \`${userId}\`\n` +
            `**Motivo:** ${reason}`,
            "danger"
        );

    } catch (error) {

        console.error(
            "Erro ao punir usuário Anti-Nuke:",
            error
        );
    }
}

// ============================================================
// AUDIT LOG - AÇÕES DE NUKE
// ============================================================

client.on(
    "guildAuditLogEntryCreate",
    async (entry, guild) => {

        try {

            if (
                PROTECTED_GUILD_ID &&
                guild.id !==
                PROTECTED_GUILD_ID
            ) {
                return;
            }

            const executorId =
                entry.executorId;

            if (!executorId) {
                return;
            }

            if (
                executorId ===
                client.user.id
            ) {
                return;
            }

            if (
                isTrustedUser(
                    executorId
                )
            ) {
                return;
            }

            let reason = null;

            switch (entry.action) {

                case AuditLogEvent.ChannelDelete:
                    reason =
                        "exclusão de canal";
                    break;

                case AuditLogEvent.RoleDelete:
                    reason =
                        "exclusão de cargo";
                    break;

                case AuditLogEvent.MemberBanAdd:
                    reason =
                        "banimento de membro";
                    break;

                case AuditLogEvent.MemberKick:
                    reason =
                        "expulsão de membro";
                    break;

                case AuditLogEvent.WebhookCreate:
                    // Webhook possui sistema próprio.
                    return;

                case AuditLogEvent.BotAdd:
                    // Bot possui sistema próprio.
                    return;

                default:
                    return;
            }

            const count =
                registerNukeAction(
                    guild,
                    executorId
                );

            await sendLog(
                guild,
                "⚠️ AÇÃO ANTI-NUKE DETECTADA",
                `Uma ação destrutiva foi detectada.\n\n` +
                `**Responsável:** <@${executorId}>\n` +
                `**Ação:** ${reason}\n` +
                `**Contagem:** ${count}/${NUKE_LIMIT}`,
                "warning"
            );

            if (
                count >=
                NUKE_LIMIT
            ) {

                await punishNukeUser(
                    guild,
                    executorId,
                    `excesso de ${reason}`
                );
            }

        } catch (error) {

            console.error(
                "Erro no Audit Log Anti-Nuke:",
                error
            );
        }
    }
);

// ============================================================
// RESTAURAR CARGO
// ============================================================

async function restoreRole(
    guild,
    roleId
) {

    try {

        const backup =
            roleBackup.get(
                guild.id
            ) || [];

        const roleData =
            backup.find(
                role =>
                    role.id === roleId
            );

        if (!roleData) {
            return;
        }

        // Se o cargo ainda existe, não recriar.
        if (
            guild.roles.cache.has(
                roleId
            )
        ) {
            return;
        }

        const newRole =
            await guild.roles.create({
                name: roleData.name,
                color: roleData.color,
                hoist: roleData.hoist,
                permissions:
                    BigInt(
                        roleData.permissions
                    ),
                mentionable:
                    roleData.mentionable,
                reason:
                    "Anti-Nuke: restauração de cargo"
            });

        try {

            await newRole.setPosition(
                roleData.position,
                {
                    reason:
                        "Anti-Nuke: restaurar posição"
                }
            );

        } catch {}

        await sendLog(
            guild,
            "♻️ CARGO RESTAURADO",
            `Um cargo apagado foi restaurado.\n\n` +
            `**Cargo:** ${newRole.name}\n` +
            `**Novo ID:** \`${newRole.id}\``,
            "success"
        );

    } catch (error) {

        console.error(
            "Erro ao restaurar cargo:",
            error
        );
    }
}

// ============================================================
// RESTAURAR CANAL
// ============================================================

async function restoreChannel(
    guild,
    channelId
) {

    try {

        const backup =
            channelBackup.get(
                guild.id
            ) || [];

        const data =
            backup.find(
                channel =>
                    channel.id === channelId
            );

        if (!data) {
            return;
        }

        // Se ainda existe, não recriar.
        if (
            guild.channels.cache.has(
                channelId
            )
        ) {
            return;
        }

        let parent = null;

        if (
            data.parentId
        ) {

            parent =
                guild.channels.cache.get(
                    data.parentId
                ) || null;
        }

        let options = {
            name: data.name,
            type: data.type,
            reason:
                "Anti-Nuke: restauração de canal"
        };

        if (parent) {
            options.parent = parent.id;
        }

        if (
            data.topic !== null &&
            (
                data.type ===
                ChannelType.GuildText ||
                data.type ===
                ChannelType.GuildAnnouncement ||
                data.type ===
                ChannelType.GuildForum
            )
        ) {
            options.topic =
                data.topic;
        }

        if (
            data.type ===
            ChannelType.GuildText ||
            data.type ===
            ChannelType.GuildAnnouncement
        ) {

            options.nsfw =
                Boolean(
                    data.nsfw
                );

            options.rateLimitPerUser =
                data.rateLimitPerUser || 0;
        }

        const newChannel =
            await guild.channels.create(
                options
            );

        try {

            await newChannel.setPosition(
                data.position,
                {
                    reason:
                        "Anti-Nuke: restaurar posição"
                }
            );

        } catch {}

        await sendLog(
            guild,
            "♻️ CANAL RESTAURADO",
            `Um canal apagado foi restaurado.\n\n` +
            `**Canal:** ${newChannel.name}\n` +
            `**Novo ID:** \`${newChannel.id}\``,
            "success"
        );

    } catch (error) {

        console.error(
            "Erro ao restaurar canal:",
            error
        );
    }
}

// ============================================================
// EVENTO DE EXCLUSÃO DE CANAL
// ============================================================

client.on(
    "channelDelete",
    async channel => {

        try {

            if (!channel.guild) {
                return;
            }

            const guild =
                channel.guild;

            if (
                PROTECTED_GUILD_ID &&
                guild.id !==
                PROTECTED_GUILD_ID
            ) {
                return;
            }

            const entry =
                await getRecentAuditEntry(
                    guild,
                    AuditLogEvent.ChannelDelete,
                    channel.id
                );

            if (!entry) {
                return;
            }

            const executorId =
                entry.executorId;

            if (
                !executorId ||
                isTrustedUser(executorId)
            ) {
                return;
            }

            const count =
                registerNukeAction(
                    guild,
                    executorId
                );

            await sendLog(
                guild,
                "🗑️ CANAL APAGADO",
                `Um canal foi apagado.\n\n` +
                `**Canal:** #${channel.name}\n` +
                `**Responsável:** <@${executorId}>\n` +
                `**Contagem Anti-Nuke:** ${count}/${NUKE_LIMIT}`,
                "warning"
            );

            if (
                count >=
                NUKE_LIMIT
            ) {

                await restoreChannel(
                    guild,
                    channel.id
                );

                await punishNukeUser(
                    guild,
                    executorId,
                    "exclusão em massa de canais"
                );
            }

        } catch (error) {

            console.error(
                "Erro channelDelete:",
                error
            );
        }
    }
);

// ============================================================
// EVENTO DE EXCLUSÃO DE CARGO
// ============================================================

client.on(
    "roleDelete",
    async role => {

        try {

            const guild =
                role.guild;

            if (
                PROTECTED_GUILD_ID &&
                guild.id !==
                PROTECTED_GUILD_ID
            ) {
                return;
            }

            const entry =
                await getRecentAuditEntry(
                    guild,
                    AuditLogEvent.RoleDelete,
                    role.id
                );

            if (!entry) {
                return;
            }

            const executorId =
                entry.executorId;

            if (
                !executorId ||
                isTrustedUser(executorId)
            ) {
                return;
            }

            const count =
                registerNukeAction(
                    guild,
                    executorId
                );

            await sendLog(
                guild,
                "🗑️ CARGO APAGADO",
                `Um cargo foi apagado.\n\n` +
                `**Cargo:** ${role.name}\n` +
                `**Responsável:** <@${executorId}>\n` +
                `**Contagem Anti-Nuke:** ${count}/${NUKE_LIMIT}`,
                "warning"
            );

            if (
                count >=
                NUKE_LIMIT
            ) {

                await restoreRole(
                    guild,
                    role.id
                );

                await punishNukeUser(
                    guild,
                    executorId,
                    "exclusão em massa de cargos"
                );
            }

        } catch (error) {

            console.error(
                "Erro roleDelete:",
                error
            );
        }
    }
);

// ============================================================
// READY
// ============================================================

client.once(
    "ready",
    async () => {

        console.log(
            "======================================"
        );

        console.log(
            `🛡️ ${client.user.tag} online`
        );

        console.log(
            "======================================"
        );

        try {

            let guild = null;

            if (
                PROTECTED_GUILD_ID
            ) {

                guild =
                    client.guilds.cache.get(
                        PROTECTED_GUILD_ID
                    );

            } else {

                guild =
                    client.guilds.cache.first();
            }

            if (!guild) {

                console.error(
                    "❌ Nenhum servidor encontrado."
                );

                return;
            }

            console.log(
                `🏠 Servidor: ${guild.name}`
            );

            // =================================================
            // PRIMEIRO:
            // CARREGAR BACKUP
            // =================================================

            loadBackupFile(
                guild
            );

            // =================================================
            // SEGUNDO:
            // PROTEGER TODOS OS BOTS EXISTENTES
            //
            // ISSO É O QUE EVITA O PROBLEMA ANTERIOR.
            // =================================================

            await initializeAuthorizedBots(
                guild
            );

            // =================================================
            // TERCEIRO:
            // CRIAR BACKUP
            // =================================================

            createRoleBackup(
                guild
            );

            createChannelBackup(
                guild
            );

            // =================================================
            // QUARTO:
            // PRESERVAR WEBHOOKS EXISTENTES
            // =================================================

            await initializeWebhooks(
                guild
            );

            await sendLog(
                guild,
                "🛡️ ANTI-NUKE ONLINE",
                `Sistema de proteção iniciado com sucesso.\n\n` +
                `🤖 Bots existentes protegidos\n` +
                `🪝 Webhooks existentes preservados\n` +
                `💬 Anti-Spam ativo\n` +
                `🛡️ Anti-Nuke ativo\n` +
                `♻️ Backup ativo`,
                "success"
            );

        } catch (error) {

            console.error(
                "Erro durante inicialização:",
                error
            );
        }
    }
);

// ============================================================
// ERROS
// ============================================================

client.on(
    "error",
    error => {

        console.error(
            "Discord Client Error:",
            error
        );
    }
);

process.on(
    "unhandledRejection",
    error => {

        console.error(
            "Unhandled Rejection:",
            error
        );
    }
);

process.on(
    "uncaughtException",
    error => {

        console.error(
            "Uncaught Exception:",
            error
        );
    }
);

// ============================================================
// LOGIN
// ============================================================

client.login(TOKEN);
