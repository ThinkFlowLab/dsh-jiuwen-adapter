window.__ModuleLoader__.load({
	id: "@dsh-jiuwen/adapter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		/**
		 * Pure helpers for the Settings → Models Jiuwen card.
		 * Safe to import from Node tests (no DOM).
		 */

		const SETTINGS_NS = 'llm-jiuwen'
		const DEFAULT_API_KEY_ENV = 'JIUWEN_API_KEY'
		const DEFAULT_MODELS = [
		  { id: 'jiuwen-default', name: 'Jiuwen Default', contextWindow: 128000, maxTokens: 8192 },
		  { id: 'jiuwen-swarm', name: 'Jiuwen Swarm', contextWindow: 128000, maxTokens: 8192 },
		]

		function modelsFromValue(value) {
		  const list = value && Array.isArray(value.models) ? value.models : null
		  if (!list || list.length === 0) return DEFAULT_MODELS.map(m => ({ ...m }))
		  return list.map((m) => ({
		    id: String(m?.id || '').trim(),
		    name: String(m?.name || m?.id || '').trim(),
		    ...(m?.modelName ? { modelName: String(m.modelName).trim() } : {}),
		    ...(Number(m?.contextWindow) > 0 ? { contextWindow: Number(m.contextWindow) } : {}),
		    ...(Number(m?.maxTokens) > 0 ? { maxTokens: Number(m.maxTokens) } : {}),
		  }))
		}

		function validateModels(models) {
		  const seen = new Set()
		  for (let i = 0; i < models.length; i++) {
		    const id = models[i]?.id
		    if (!id) return { index: i, message: 'Each model needs an id.' }
		    if (seen.has(id)) return { index: i, message: `Model id "${id}" is used twice.` }
		    seen.add(id)
		  }
		  if (models.length === 0) return { index: 0, message: 'Add at least one model.' }
		  return undefined
		}

		function pathOpsForDraft(before, after) {
		  const ops = []
		  for (const key of ['baseURL', 'displayName', 'defaultModel', 'apiKeyEnv', 'models']) {
		    const prev = before?.[key]
		    const next = after?.[key]
		    const same = JSON.stringify(prev ?? null) === JSON.stringify(next ?? null)
		    if (same) continue
		    if (next === undefined || next === '') ops.push({ op: 'unset', path: [key] })
		    else ops.push({ op: 'set', path: [key], value: next })
		  }
		  return ops
		}

		function namespaceValue(describeResult, ns = SETTINGS_NS) {
		  const doc = describeResult?.value || describeResult
		  const list = doc?.namespaces || []
		  return list.find(n => n?.ns === ns)
		}

		const inject = ['slots', 'remote', 'remote.credentials', 'remote.settings']

		function copy(en, zh) {
		  const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
		  return String(lang).toLowerCase().startsWith('zh') ? zh : en
		}

		function emptyModel() {
		  return { id: '', name: '', modelName: '', contextWindow: 128000, maxTokens: 8192 }
		}

		function JiuwenModelsCard(props) {
		  const ctx = props.ctx
		  const [status, setStatus] = useState('loading')
		  const [error, setError] = useState('')
		  const [saved, setSaved] = useState(false)
		  const [busy, setBusy] = useState(false)
		  const [revision, setRevision] = useState(undefined)
		  const [baseURL, setBaseURL] = useState('')
		  const [defaultModel, setDefaultModel] = useState('jiuwen-default')
		  const [apiKeyEnv, setApiKeyEnv] = useState(DEFAULT_API_KEY_ENV)
		  const [keyDraft, setKeyDraft] = useState('')
		  const [showKey, setShowKey] = useState(false)
		  const [keyConfigured, setKeyConfigured] = useState(false)
		  const [models, setModels] = useState(DEFAULT_MODELS.map(m => ({ ...m, modelName: '' })))
		  const [writable, setWritable] = useState(true)

		  async function load() {
		    if (!ctx?.remote?.settings?.describe) {
		      setStatus('ready')
		      return
		    }
		    setStatus('loading')
		    setError('')
		    try {
		      const described = await ctx.remote.settings.describe()
		      const doc = described?.ok === false ? null : (described?.value || described)
		      if (described?.ok === false) throw new Error(described.error?.message || 'Could not read settings')
		      setWritable(doc?.writable !== false)
		      const ns = namespaceValue(doc, SETTINGS_NS)
		      const value = (ns && typeof ns.value === 'object' && ns.value) || {}
		      setRevision(ns?.revision)
		      setBaseURL(typeof value.baseURL === 'string' ? value.baseURL : '')
		      setDefaultModel(typeof value.defaultModel === 'string' ? value.defaultModel : 'jiuwen-default')
		      setApiKeyEnv(typeof value.apiKeyEnv === 'string' && value.apiKeyEnv ? value.apiKeyEnv : DEFAULT_API_KEY_ENV)
		      setModels(modelsFromValue(value).map(m => ({ modelName: '', ...m })))
		      const ref = (typeof value.apiKeyEnv === 'string' && value.apiKeyEnv) || DEFAULT_API_KEY_ENV
		      if (ctx.remote.credentials?.describe) {
		        const info = await ctx.remote.credentials.describe([ref])
		        const body = info?.ok === false ? null : (info?.value || info)
		        const row = body && (body[ref] || body)
		        setKeyConfigured(Boolean(row && (row.configured === true || row.source)))
		      }
		      setStatus('ready')
		    } catch (e) {
		      setStatus('ready')
		      setError(String(e?.message || e))
		    }
		  }

		  useEffect(() => { void load() }, [])

		  async function apply() {
		    const problem = validateModels(models)
		    if (problem) { setError(problem.message); return }
		    if (!writable) return
		    setBusy(true)
		    setError('')
		    setSaved(false)
		    try {
		      const ref = apiKeyEnv || DEFAULT_API_KEY_ENV
		      if (keyDraft && ctx.remote.credentials?.set) {
		        const res = await ctx.remote.credentials.set(ref, keyDraft)
		        if (res && res.ok === false) throw new Error(res.error?.message || 'Could not store the API key')
		        setKeyDraft('')
		        setKeyConfigured(true)
		      }
		      const after = {
		        baseURL: baseURL.trim(),
		        defaultModel: defaultModel.trim() || models[0]?.id,
		        apiKeyEnv: ref,
		        models: models.map(m => ({
		          id: m.id.trim(),
		          name: (m.name || m.id).trim(),
		          ...(m.modelName && m.modelName.trim() ? { modelName: m.modelName.trim() } : {}),
		          ...(Number(m.contextWindow) > 0 ? { contextWindow: Number(m.contextWindow) } : {}),
		          ...(Number(m.maxTokens) > 0 ? { maxTokens: Number(m.maxTokens) } : {}),
		        })),
		      }
		      const ops = pathOpsForDraft({}, after)
		      if (ops.length && ctx.remote.settings?.mutate) {
		        const res = await ctx.remote.settings.mutate(SETTINGS_NS, ops, revision)
		        if (res && res.ok === false) {
		          const msg = res.error?.message || 'Could not save settings'
		          if (res.error?.code === 'settings/conflict') throw new Error(copy('Settings changed elsewhere — reload and try again.', '设置已被其他地方修改，请重新加载后再试。'))
		          throw new Error(msg)
		        }
		        const view = res?.value || res
		        if (view && typeof view.revision === 'number') setRevision(view.revision)
		      }
		      setSaved(true)
		    } catch (e) {
		      setError(String(e?.message || e))
		    } finally {
		      setBusy(false)
		    }
		  }

		  const labelStyle = { display: 'block', fontSize: 12, margin: '10px 0 4px', opacity: 0.8 }
		  const inputStyle = { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: '1px solid color-mix(in srgb, currentColor 20%, transparent)', background: 'transparent', color: 'inherit' }
		  const rowStyle = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 6, marginBottom: 6, alignItems: 'center' }

		  return h('div', { style: { marginTop: 8, padding: '8px 0 4px' } },
		    h('p', { style: { margin: '0 0 8px', fontSize: 13, lineHeight: 1.45 } },
		      copy(
		        'Set the endpoint, API key and model list here. Then pick a Jiuwen model in the composer (or set it as the default). Changes apply on the next turn.',
		        '在这里填写接口地址、API Key 和模型列表，然后在对话输入框里选择 Jiuwen 模型（或设为默认）。下次对话即生效。',
		      ),
		    ),
		    h('label', { style: labelStyle }, copy('Endpoint (API base)', '接口地址（API Base）')),
		    h('input', {
		      type: 'url',
		      style: inputStyle,
		      placeholder: 'https://api.example.com/v1',
		      value: baseURL,
		      disabled: !writable || busy,
		      onChange: (e) => setBaseURL(e.target.value),
		      autoComplete: 'off',
		    }),
		    h('label', { style: labelStyle }, copy('API key', 'API Key')),
		    h('div', { style: { display: 'flex', gap: 6 } },
		      h('input', {
		        type: showKey ? 'text' : 'password',
		        style: { ...inputStyle, flex: 1 },
		        placeholder: keyConfigured
		          ? copy('Saved — paste a new key to replace it', '已保存 — 粘贴新密钥可替换')
		          : copy('Paste key (stored write-only, never in YAML)', '粘贴密钥（只写存储，不会写入 YAML）'),
		        value: keyDraft,
		        disabled: !writable || busy,
		        onChange: (e) => { setKeyDraft(e.target.value); setShowKey(false) },
		        autoComplete: 'new-password',
		      }),
		      h('button', {
		        type: 'button',
		        disabled: !keyDraft,
		        onClick: () => setShowKey(s => !s),
		        style: { padding: '6px 8px' },
		      }, showKey ? copy('Hide', '隐藏') : copy('Show', '显示')),
		    ),
		    h('label', { style: labelStyle }, copy('Models', '模型')),
		    models.map((m, i) => h('div', { key: i, style: rowStyle },
		      h('input', { style: inputStyle, placeholder: copy('id (sent to the API)', 'id（发给接口的模型名）'), value: m.id, disabled: !writable || busy, onChange: (e) => {
		        const next = models.slice(); next[i] = { ...m, id: e.target.value }; setModels(next)
		        if (defaultModel === m.id) setDefaultModel(e.target.value)
		      } }),
		      h('input', { style: inputStyle, placeholder: copy('display name', '显示名'), value: m.name, disabled: !writable || busy, onChange: (e) => {
		        const next = models.slice(); next[i] = { ...m, name: e.target.value }; setModels(next)
		      } }),
		      h('input', { style: inputStyle, placeholder: copy('API name if id is an alias', '若 id 是别名，填写真实模型名'), value: m.modelName || '', disabled: !writable || busy, onChange: (e) => {
		        const next = models.slice(); next[i] = { ...m, modelName: e.target.value }; setModels(next)
		      } }),
		      h('button', { type: 'button', disabled: !writable || busy || models.length < 2, onClick: () => {
		        const next = models.filter((_, j) => j !== i)
		        setModels(next)
		        if (defaultModel === m.id) setDefaultModel(next[0]?.id || '')
		      } }, copy('Remove', '删除')),
		    )),
		    h('div', { style: { display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' } },
		      h('button', { type: 'button', disabled: !writable || busy, onClick: () => setModels(models.concat(emptyModel())) },
		        copy('Add model', '添加模型')),
		      h('label', { style: { ...labelStyle, margin: 0, display: 'flex', alignItems: 'center', gap: 6 } },
		        copy('Default', '默认'),
		        h('select', {
		          value: defaultModel,
		          disabled: !writable || busy,
		          onChange: (e) => setDefaultModel(e.target.value),
		        }, models.map((m, i) => h('option', { key: i, value: m.id }, m.name || m.id || copy('(untitled)', '（未命名）')))),
		      ),
		    ),
		    error ? h('p', { role: 'alert', style: { color: 'var(--dsw-alias-danger, #c00)', fontSize: 13 } }, error) : null,
		    saved ? h('p', { role: 'status', style: { fontSize: 13, margin: '8px 0 0' } }, copy('Saved. New turns use this model configuration.', '已保存。之后的对话会使用这套模型配置。')) : null,
		    h('div', { style: { marginTop: 10 } },
		      h('button', { type: 'button', disabled: !writable || busy || status !== 'ready', onClick: () => { void apply() } },
		        busy ? copy('Saving…', '保存中…') : copy('Apply', '应用')),
		    ),
		  )
		}

		function apply(ctx) {
		  if (typeof ctx?.slots?.inject !== 'function' || typeof ctx?.slots?.register !== 'function') return
		  ctx.slots.inject('settings.models.provider-card', function* () {
		    yield ctx.slots.register(
		      { name: 'settings.models.provider-card', key: SETTINGS_NS },
		      function JiuwenCard(owner) {
		        return h(JiuwenModelsCard, { ...owner, ctx })
		      },
		    )
		  })
		}

		module.exports = { apply, inject, JiuwenModelsCard, SETTINGS_NS }

		return module.exports;
	}
});
