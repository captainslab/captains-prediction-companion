import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { loadJsonFile, writeJsonFileAtomic } from './storage.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_STATE_FILE = resolve(__dirname, '../data/captainlabs-state.json')
const DEFAULT_USER_ID = 'user-1'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function iso(minutesAgo, baseTime = Date.now()) {
  return new Date(baseTime - minutesAgo * 60_000).toISOString()
}

function roundMoney(value) {
  return Math.round(Number(value ?? 0) * 100) / 100
}

function roundRatio(value) {
  return Math.round(Number(value ?? 0) * 100) / 100
}

function todayStartMs(now = Date.now()) {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function seedState(baseTime = Date.now()) {
  const userId = DEFAULT_USER_ID
  const walletA = '0x8fa1c7e4cba2000000000000000000000000a001'
  const walletB = '0x8fa1c7e4cba2000000000000000000000000a002'
  const botA = 'bot-simmer-main'
  const botB = 'bot-wallet-alpha'
  const botC = 'bot-api-shadow'

  return {
    users: [
      {
        id: userId,
        profile: {
          name: 'Demo User',
          email: 'user@captainlabs.io',
          role: 'trader',
        },
        preferences: {
          defaultSurface: 'companion',
          theme: 'dark',
          walletFirstOnboarding: true,
        },
      },
    ],
    wallets: [
      {
        id: 'wallet-1',
        userId,
        label: 'Main wallet',
        address: walletA,
        chain: 'base',
        createdAt: iso(650, baseTime),
      },
      {
        id: 'wallet-2',
        userId,
        label: 'Reserve wallet',
        address: walletB,
        chain: 'polygon',
        createdAt: iso(610, baseTime),
      },
    ],
    bots: [
      {
        id: botA,
        userId,
        name: 'Simmer Main',
        type: 'internal_bot',
        status: 'active',
        strategyLabel: 'Earnings mention scanner',
        walletAddress: walletA,
        chain: 'base',
        exchange: 'Kalshi',
        apiBaseUrl: null,
        lastHeartbeatAt: iso(4, baseTime),
        createdAt: iso(620, baseTime),
        updatedAt: iso(4, baseTime),
      },
      {
        id: botB,
        userId,
        name: 'Wallet Alpha',
        type: 'wallet_only',
        status: 'paused',
        strategyLabel: 'Wallet-first starter profile',
        walletAddress: walletB,
        chain: 'polygon',
        exchange: 'Kalshi',
        apiBaseUrl: null,
        lastHeartbeatAt: iso(38, baseTime),
        createdAt: iso(590, baseTime),
        updatedAt: iso(38, baseTime),
      },
      {
        id: botC,
        userId,
        name: 'API Shadow',
        type: 'api_connected',
        status: 'disconnected',
        strategyLabel: 'External connector placeholder',
        walletAddress: null,
        chain: 'arbitrum',
        exchange: 'Polymarket',
        apiBaseUrl: 'https://bot.captainlabs.io/api',
        lastHeartbeatAt: iso(180, baseTime),
        createdAt: iso(560, baseTime),
        updatedAt: iso(180, baseTime),
      },
    ],
    positions: [
      {
        id: 'position-1',
        ownerType: 'user',
        ownerId: userId,
        market: 'NVIDIA Q4 revenue beats',
        side: 'yes',
        entryPrice: 0.61,
        currentPrice: 0.66,
        quantity: 120,
        pnlDollars: 6.0,
        pnlPercent: 8.2,
        status: 'open',
        openedAt: iso(48, baseTime),
        updatedAt: iso(2, baseTime),
      },
      {
        id: 'position-2',
        ownerType: 'user',
        ownerId: userId,
        market: 'Fed cuts by 25bps this meeting',
        side: 'no',
        entryPrice: 0.44,
        currentPrice: 0.38,
        quantity: 90,
        pnlDollars: 5.4,
        pnlPercent: 13.6,
        status: 'open',
        openedAt: iso(110, baseTime),
        updatedAt: iso(12, baseTime),
      },
      {
        id: 'position-3',
        ownerType: 'bot',
        ownerId: botA,
        market: 'AXP earnings mention',
        side: 'watch',
        entryPrice: 0.32,
        currentPrice: 0.35,
        quantity: 75,
        pnlDollars: 2.25,
        pnlPercent: 9.4,
        status: 'open',
        openedAt: iso(82, baseTime),
        updatedAt: iso(7, baseTime),
      },
      {
        id: 'position-4',
        ownerType: 'bot',
        ownerId: botA,
        market: 'Intel earnings mention',
        side: 'no',
        entryPrice: 0.28,
        currentPrice: 0.24,
        quantity: 50,
        pnlDollars: 2.0,
        pnlPercent: 14.3,
        status: 'open',
        openedAt: iso(68, baseTime),
        updatedAt: iso(6, baseTime),
      },
      {
        id: 'position-5',
        ownerType: 'bot',
        ownerId: botB,
        market: 'Whale mentions during earnings call',
        side: 'yes',
        entryPrice: 0.19,
        currentPrice: 0.22,
        quantity: 40,
        pnlDollars: 1.2,
        pnlPercent: 15.8,
        status: 'open',
        openedAt: iso(95, baseTime),
        updatedAt: iso(18, baseTime),
      },
    ],
    actions: [
      {
        id: 'action-1',
        botId: botA,
        timestamp: iso(6, baseTime),
        type: 'buy',
        market: 'Intel earnings mention',
        price: 0.24,
        quantity: 50,
        reason: 'No-edge filter tightened after fresh source packet',
      },
      {
        id: 'action-2',
        botId: botA,
        timestamp: iso(18, baseTime),
        type: 'adjust',
        market: 'AXP earnings mention',
        price: 0.35,
        quantity: 25,
        reason: 'Added size after clean source alignment',
      },
      {
        id: 'action-3',
        botId: botB,
        timestamp: iso(38, baseTime),
        type: 'pause',
        market: 'Wallet-first starter profile',
        price: null,
        quantity: 0,
        reason: 'Paused while wallet onboarding remains manual',
      },
      {
        id: 'action-4',
        botId: botA,
        timestamp: iso(52, baseTime),
        type: 'buy',
        market: 'NVIDIA Q4 revenue beats',
        price: 0.61,
        quantity: 120,
        reason: 'Decision-layer consensus favored the yes side',
      },
    ],
    companionHistory: [
      {
        id: 'request-1',
        userId,
        inputType: 'market_url',
        inputValue: 'https://kalshi.com/markets/kxearningsmentionintc/intel-earnings-call/kxearningsmentionintc-26apr23',
        responseSummary: 'Intel mention board resolved to a watch posture with no strong edge.',
        createdAt: iso(7, baseTime),
      },
      {
        id: 'request-2',
        userId,
        inputType: 'wallet',
        inputValue: walletA,
        responseSummary: 'Wallet is funded and attached to the active simmer profile.',
        createdAt: iso(26, baseTime),
      },
      {
        id: 'request-3',
        userId,
        inputType: 'position',
        inputValue: 'position-3',
        responseSummary: 'Bot position remains open with mild positive pnl.',
        createdAt: iso(42, baseTime),
      },
      {
        id: 'request-4',
        userId,
        inputType: 'freeform',
        inputValue: 'Show all surfaces',
        responseSummary: 'Companion, Dashboard, and Bot Dash are ready for a single-user demo.',
        createdAt: iso(70, baseTime),
      },
    ],
  }
}

function normalizeState(raw, baseTime = Date.now()) {
  const seed = seedState(baseTime)
  if (!raw || typeof raw !== 'object') return seed

  return {
    users: Array.isArray(raw.users) && raw.users.length > 0 ? raw.users : seed.users,
    wallets: Array.isArray(raw.wallets) && raw.wallets.length > 0 ? raw.wallets : seed.wallets,
    bots: Array.isArray(raw.bots) && raw.bots.length > 0 ? raw.bots : seed.bots,
    positions:
      Array.isArray(raw.positions) && raw.positions.length > 0 ? raw.positions : seed.positions,
    actions: Array.isArray(raw.actions) && raw.actions.length > 0 ? raw.actions : seed.actions,
    companionHistory:
      Array.isArray(raw.companionHistory) && raw.companionHistory.length > 0
        ? raw.companionHistory
        : seed.companionHistory,
  }
}

function sortNewest(items, key) {
  return [...items].sort((left, right) => {
    const leftTime = new Date(left?.[key] ?? 0).getTime()
    const rightTime = new Date(right?.[key] ?? 0).getTime()
    return rightTime - leftTime
  })
}

function getUserBotIds(state, userId) {
  return state.bots.filter((bot) => bot.userId === userId).map((bot) => bot.id)
}

function performanceFromPositions({ positions, actions, now }) {
  const latestPositions = sortNewest(positions, 'updatedAt')
  const totalPnl = roundMoney(latestPositions.reduce((sum, position) => sum + Number(position.pnlDollars ?? 0), 0))
  const closedPositions = latestPositions.filter((position) => String(position.status ?? '').toLowerCase() !== 'open')
  const wins = closedPositions.filter((position) => Number(position.pnlDollars ?? 0) > 0).length
  const openPositions = latestPositions.filter((position) => String(position.status ?? '').toLowerCase() === 'open').length
  const todayBoundary = todayStartMs(now)
  const todaysPositions = latestPositions.filter(
    (position) => new Date(position.updatedAt ?? position.openedAt ?? 0).getTime() >= todayBoundary
  )
  const todayPnl = roundMoney(
    todaysPositions.reduce((sum, position) => sum + Number(position.pnlDollars ?? 0), 0)
  )
  const tradesToday = sortNewest(actions, 'timestamp').filter(
    (action) => new Date(action.timestamp ?? 0).getTime() >= todayBoundary
  ).length

  return {
    totalPnl,
    todayPnl,
    winRate: roundRatio(closedPositions.length > 0 ? wins / closedPositions.length : 0),
    tradesToday,
    openPositions,
    updatedAt: new Date(now).toISOString(),
  }
}

function createBotStatusView(bot, actions, positions, now) {
  const orderedActions = sortNewest(actions, 'timestamp')
  const orderedPositions = sortNewest(positions, 'updatedAt')
  return {
    botId: bot.id,
    status: bot.status,
    strategyLabel: bot.strategyLabel,
    lastAction: orderedActions[0]?.type ?? null,
    lastActionAt: orderedActions[0]?.timestamp ?? null,
    lastUpdate: orderedPositions[0]?.updatedAt ?? bot.updatedAt,
    lastHeartbeatAt: bot.lastHeartbeatAt,
    exchange: bot.exchange,
    walletAddress: bot.walletAddress,
    chain: bot.chain,
    updatedAt: new Date(now).toISOString(),
  }
}

function createPositionActivity(position, ownerLabel, kind = 'position') {
  return {
    id: position.id,
    timestamp: position.updatedAt,
    type: kind,
    market: position.market,
    side: position.side,
    quantity: position.quantity,
    summary: `${ownerLabel}: ${position.market} (${position.side.toUpperCase()})`,
    pnlDollars: position.pnlDollars,
    pnlPercent: position.pnlPercent,
  }
}

export function createCaptainLabsStore({ filePath = DEFAULT_STATE_FILE, now = () => new Date() } = {}) {
  const initialState = normalizeState(loadJsonFile(filePath, null), now().getTime())
  let state = initialState

  function persist() {
    writeJsonFileAtomic(filePath, state)
  }

  function currentUser() {
    return state.users[0] ?? null
  }

  function getUser(userId = DEFAULT_USER_ID) {
    return state.users.find((user) => user.id === userId) ?? null
  }

  function getWallet(walletId) {
    return state.wallets.find((wallet) => wallet.id === walletId) ?? null
  }

  function listWallets(userId = currentUser()?.id ?? DEFAULT_USER_ID) {
    return state.wallets.filter((wallet) => wallet.userId === userId)
  }

  function createWallet(input = {}) {
    const userId = typeof input.userId === 'string' && input.userId ? input.userId : currentUser()?.id ?? DEFAULT_USER_ID
    const wallet = {
      id: `wallet-${randomUUID()}`,
      userId,
      label: String(input.label ?? 'New wallet'),
      address: String(input.address ?? '').trim(),
      chain: String(input.chain ?? 'base').trim() || 'base',
      createdAt: new Date(now()).toISOString(),
    }

    state.wallets = [wallet, ...state.wallets]
    persist()
    return wallet
  }

  function deleteWallet(walletId) {
    const existing = getWallet(walletId)
    if (!existing) return null
    state.wallets = state.wallets.filter((wallet) => wallet.id !== walletId)
    persist()
    return existing
  }

  function listBots(userId = currentUser()?.id ?? DEFAULT_USER_ID) {
    return state.bots.filter((bot) => bot.userId === userId)
  }

  function getBot(botId) {
    return state.bots.find((bot) => bot.id === botId) ?? null
  }

  function createBot(input = {}) {
    const userId = typeof input.userId === 'string' && input.userId ? input.userId : currentUser()?.id ?? DEFAULT_USER_ID
    const bot = {
      id: `bot-${randomUUID()}`,
      userId,
      name: String(input.name ?? 'New bot').trim() || 'New bot',
      type: input.type === 'api_connected' || input.type === 'internal_bot' ? input.type : 'wallet_only',
      status: input.status === 'active' || input.status === 'paused' || input.status === 'error' || input.status === 'disconnected'
        ? input.status
        : 'paused',
      strategyLabel: String(input.strategyLabel ?? 'Wallet-first starter profile').trim(),
      walletAddress: input.walletAddress ? String(input.walletAddress).trim() : null,
      chain: String(input.chain ?? 'base').trim() || 'base',
      exchange: String(input.exchange ?? 'Kalshi').trim() || 'Kalshi',
      apiBaseUrl: input.apiBaseUrl ? String(input.apiBaseUrl).trim() : null,
      lastHeartbeatAt: input.lastHeartbeatAt ?? null,
      createdAt: new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
    }

    state.bots = [bot, ...state.bots]
    persist()
    return bot
  }

  function updateBot(botId, patch = {}) {
    const bot = getBot(botId)
    if (!bot) return null

    const nextBot = {
      ...bot,
      ...patch,
      id: bot.id,
      userId: bot.userId,
      updatedAt: new Date(now()).toISOString(),
    }

    state.bots = state.bots.map((entry) => (entry.id === botId ? nextBot : entry))
    persist()
    return nextBot
  }

  function recordBotAction(botId, action) {
    const bot = getBot(botId)
    if (!bot) return null

    const entry = {
      id: `action-${randomUUID()}`,
      botId,
      timestamp: new Date(now()).toISOString(),
      type: String(action.type ?? 'status'),
      market: String(action.market ?? bot.name),
      price: action.price ?? null,
      quantity: Number(action.quantity ?? 0),
      reason: String(action.reason ?? '').trim() || null,
    }

    state.actions = [entry, ...state.actions]
    state.bots = state.bots.map((item) =>
      item.id === botId
        ? { ...item, lastHeartbeatAt: entry.timestamp, updatedAt: entry.timestamp }
        : item
    )
    persist()
    return entry
  }

  function startBot(botId) {
    const updated = updateBot(botId, {
      status: 'active',
      lastHeartbeatAt: new Date(now()).toISOString(),
    })
    if (!updated) return null
    recordBotAction(botId, {
      type: 'start',
      market: updated.name,
      price: null,
      quantity: 0,
      reason: 'Bot started from Bot Dash',
    })
    return getBot(botId)
  }

  function stopBot(botId) {
    const updated = updateBot(botId, {
      status: 'paused',
      lastHeartbeatAt: new Date(now()).toISOString(),
    })
    if (!updated) return null
    recordBotAction(botId, {
      type: 'stop',
      market: updated.name,
      price: null,
      quantity: 0,
      reason: 'Bot stopped from Bot Dash',
    })
    return getBot(botId)
  }

  function listPositions({ ownerType, ownerId } = {}) {
    return state.positions.filter((position) => {
      if (ownerType && position.ownerType !== ownerType) return false
      if (ownerId && position.ownerId !== ownerId) return false
      return true
    })
  }

  function listDashboardPositions(userId = currentUser()?.id ?? DEFAULT_USER_ID) {
    const botIds = getUserBotIds(state, userId)
    return sortNewest(
      state.positions.filter(
        (position) =>
          (position.ownerType === 'user' && position.ownerId === userId) ||
          (position.ownerType === 'bot' && botIds.includes(position.ownerId))
      ),
      'updatedAt'
    )
  }

  function listBotPositions(botId) {
    return sortNewest(
      state.positions.filter((position) => position.ownerType === 'bot' && position.ownerId === botId),
      'updatedAt'
    )
  }

  function addCompanionHistory(entry) {
    const record = {
      id: `request-${randomUUID()}`,
      userId: typeof entry.userId === 'string' && entry.userId ? entry.userId : currentUser()?.id ?? DEFAULT_USER_ID,
      inputType: entry.inputType,
      inputValue: String(entry.inputValue ?? ''),
      responseSummary: String(entry.responseSummary ?? ''),
      createdAt: new Date(now()).toISOString(),
    }

    state.companionHistory = [record, ...state.companionHistory]
    persist()
    return record
  }

  function listCompanionHistory(userId = currentUser()?.id ?? DEFAULT_USER_ID) {
    return sortNewest(state.companionHistory.filter((entry) => entry.userId === userId), 'createdAt')
  }

  function getBotActions(botId) {
    return sortNewest(state.actions.filter((action) => action.botId === botId), 'timestamp')
  }

  function getBotLogs(botId) {
    const bot = getBot(botId)
    if (!bot) return []

    const actions = getBotActions(botId).slice(0, 20).map((action) => {
      const qtyText = action.quantity ? `qty ${action.quantity}` : 'no size'
      const priceText = action.price !== null && action.price !== undefined ? ` @ ${action.price}` : ''
      const reasonText = action.reason ? ` — ${action.reason}` : ''
      return `${action.timestamp} | ${action.type.toUpperCase()} | ${action.market} | ${qtyText}${priceText}${reasonText}`
    })

    return [
      `${bot.updatedAt} | status=${bot.status} | strategy=${bot.strategyLabel}`,
      ...actions,
    ]
  }

  function getBotPerformance(botId) {
    const bot = getBot(botId)
    if (!bot) return null
    const positions = listBotPositions(botId)
    const actions = getBotActions(botId)
    return performanceFromPositions({ positions, actions, now: now().getTime() })
  }

  function getWalletPositions(walletId) {
    const wallet = getWallet(walletId)
    if (!wallet) return []
    const botIds = state.bots.filter((bot) => bot.walletAddress === wallet.address).map((bot) => bot.id)
    return sortNewest(
      state.positions.filter(
        (position) =>
          (position.ownerType === 'user' && position.ownerId === wallet.userId) ||
          (position.ownerType === 'bot' && botIds.includes(position.ownerId))
      ),
      'updatedAt'
    )
  }

  function getWalletActivity(walletId) {
    const wallet = getWallet(walletId)
    if (!wallet) return []
    const botIds = state.bots.filter((bot) => bot.walletAddress === wallet.address).map((bot) => bot.id)
    const walletRequests = state.companionHistory.filter(
      (entry) => entry.userId === wallet.userId && entry.inputType === 'wallet' && entry.inputValue === wallet.address
    )
    const botActions = state.actions.filter((action) => botIds.includes(action.botId))
    const combined = [
      ...walletRequests.map((entry) => ({
        id: entry.id,
        timestamp: entry.createdAt,
        type: 'companion_request',
        market: wallet.label,
        quantity: 0,
        reason: entry.responseSummary,
      })),
      ...botActions,
    ]
    return sortNewest(combined, 'timestamp')
  }

  function getWalletPerformance(walletId) {
    const wallet = getWallet(walletId)
    if (!wallet) return null
    const positions = getWalletPositions(walletId)
    const botIds = state.bots.filter((bot) => bot.walletAddress === wallet.address).map((bot) => bot.id)
    const actions = state.actions.filter((action) => botIds.includes(action.botId))
    return performanceFromPositions({ positions, actions, now: now().getTime() })
  }

  function getDashboardActivity(userId = currentUser()?.id ?? DEFAULT_USER_ID) {
    const botIds = getUserBotIds(state, userId)
    const companionItems = listCompanionHistory(userId).map((entry) => ({
      id: entry.id,
      timestamp: entry.createdAt,
      type: `companion:${entry.inputType}`,
      market: entry.inputValue,
      quantity: 0,
      reason: entry.responseSummary,
    }))
    const botActions = state.actions
      .filter((action) => botIds.includes(action.botId))
      .map((action) => ({
        ...action,
        type: `bot:${action.type}`,
      }))
    const positions = listDashboardPositions(userId).map((position) => {
      const ownerLabel = position.ownerType === 'bot'
        ? state.bots.find((bot) => bot.id === position.ownerId)?.name ?? position.ownerId
        : 'User'
      return createPositionActivity(position, ownerLabel, `position:${position.ownerType}`)
    })

    return sortNewest([...companionItems, ...botActions, ...positions], 'timestamp').slice(0, 30)
  }

  function getDashboardPerformance(userId = currentUser()?.id ?? DEFAULT_USER_ID) {
    const botIds = getUserBotIds(state, userId)
    const positions = listDashboardPositions(userId)
    const actions = state.actions.filter((action) => botIds.includes(action.botId))
    return {
      user: performanceFromPositions({ positions, actions, now: now().getTime() }),
      bots: state.bots.filter((bot) => botIds.includes(bot.id)).map((bot) => ({
        botId: bot.id,
        botName: bot.name,
        ...performanceFromPositions({ positions: listBotPositions(bot.id), actions: getBotActions(bot.id), now: now().getTime() }),
      })),
    }
  }

  function getDashboardSummary(userId = currentUser()?.id ?? DEFAULT_USER_ID) {
    const wallets = listWallets(userId)
    const bots = listBots(userId)
    const performance = getDashboardPerformance(userId).user
    return {
      user: clone(getUser(userId)),
      summary: {
        walletCount: wallets.length,
        botCount: bots.length,
        activeBots: bots.filter((bot) => bot.status === 'active').length,
        openPositions: performance.openPositions,
        totalPnl: performance.totalPnl,
        todayPnl: performance.todayPnl,
        winRate: performance.winRate,
        tradesToday: performance.tradesToday,
        updatedAt: performance.updatedAt,
      },
    }
  }

  function getBotStatus(botId) {
    const bot = getBot(botId)
    if (!bot) return null
    return createBotStatusView(bot, getBotActions(botId), listBotPositions(botId), now().getTime())
  }

  function getBotOverview(botId) {
    const bot = getBot(botId)
    if (!bot) return null
    const status = getBotStatus(botId)
    const positions = listBotPositions(botId)
    const actions = getBotActions(botId)
    const performance = getBotPerformance(botId)
    return {
      bot: clone(bot),
      status,
      positions,
      actions,
      performance,
      logs: getBotLogs(botId),
    }
  }

  function getBotListItems(userId = currentUser()?.id ?? DEFAULT_USER_ID) {
    return listBots(userId).map((bot) => ({
      ...clone(bot),
      positionCount: listBotPositions(bot.id).length,
      actionCount: getBotActions(bot.id).length,
      lastAction: getBotActions(bot.id)[0]?.type ?? null,
      lastUpdate: getBotStatus(bot.id)?.lastUpdate ?? bot.updatedAt,
    }))
  }

  function getWalletListItems(userId = currentUser()?.id ?? DEFAULT_USER_ID) {
    return listWallets(userId).map((wallet) => ({
      ...clone(wallet),
      positionCount: getWalletPositions(wallet.id).length,
      performance: getWalletPerformance(wallet.id),
    }))
  }

  function reset(nextState) {
    state = normalizeState(nextState ?? seedState(now().getTime()), now().getTime())
    persist()
    return state
  }

  return {
    getState: () => clone(state),
    getUser,
    getWallet,
    listWallets,
    createWallet,
    deleteWallet,
    listBots,
    getBot,
    createBot,
    updateBot,
    startBot,
    stopBot,
    recordBotAction,
    listPositions,
    listDashboardPositions,
    listBotPositions,
    addCompanionHistory,
    listCompanionHistory,
    getBotActions,
    getBotLogs,
    getBotPerformance,
    getWalletPositions,
    getWalletActivity,
    getWalletPerformance,
    getDashboardActivity,
    getDashboardPerformance,
    getDashboardSummary,
    getBotStatus,
    getBotOverview,
    getBotListItems,
    getWalletListItems,
    reset,
  }
}
