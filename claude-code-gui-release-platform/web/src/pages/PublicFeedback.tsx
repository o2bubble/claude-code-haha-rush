import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ApiError, submitFeedback } from '../api/client'

const MAX_IMAGE = 10 * 1024 * 1024

export default function PublicFeedback({ siteName }: { siteName: string }) {
  const [params] = useSearchParams()
  const [type, setType] = useState<'bug' | 'suggestion'>('bug')
  const [message, setMessage] = useState('')
  const [version, setVersion] = useState(params.get('v') ?? '')
  const [image, setImage] = useState<File | null>(null)
  const [preview, setPreview] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  // 蜜罐：真实用户看不见也不会填；无头机器人常会填。填了就当垃圾丢弃。
  const [trap, setTrap] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!image) {
      setPreview('')
      return
    }
    const url = URL.createObjectURL(image)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [image])

  const pickImage = (file: File | null) => {
    setError('')
    if (!file) {
      setImage(null)
      return
    }
    if (!file.type.startsWith('image/')) {
      setError('只能上传图片文件')
      return
    }
    if (file.size > MAX_IMAGE) {
      setError(`图片不能超过 ${Math.round(MAX_IMAGE / 1024 / 1024)} MB`)
      return
    }
    setImage(file)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!message.trim() || sending) return
    if (trap.trim()) {
      // 蜜罐被填 —— 静默假装成功，不给机器人反馈
      setDone(true)
      return
    }
    setSending(true)
    setError('')
    try {
      const form = new FormData()
      form.append('type', type)
      form.append('message', message.trim())
      form.append('app_version', version.trim())
      if (image) form.append('image', image)
      await submitFeedback(form)
      setDone(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  const reset = () => {
    setDone(false)
    setMessage('')
    setImage(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  if (done) {
    return (
      <div className="public-wrap">
        <div className="public-inner">
          <div className="card" style={{ textAlign: 'center', padding: 40 }}>
            <h1 style={{ fontSize: 20, marginBottom: 8 }}>已收到，谢谢！</h1>
            <p style={{ color: 'var(--fg-secondary)', fontSize: 13, marginBottom: 20 }}>
              你的反馈已提交，我们会在后续版本中处理。
            </p>
            <button type="button" className="btn" onClick={reset}>
              再提一条
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="public-wrap">
      <form className="public-inner" onSubmit={submit}>
        <h1>意见反馈</h1>
        <div className="sub">
          遇到问题或有想法，都可以在这里告诉我们
          {siteName ? ` · ${siteName}` : ''}
        </div>

        {error && <div className="banner banner-error">{error}</div>}

        <div className="field">
          <label>反馈类型</label>
          <div className="radio-row">
            <div
              className={'radio-chip' + (type === 'bug' ? ' on' : '')}
              onClick={() => setType('bug')}
            >
              问题反馈
            </div>
            <div
              className={'radio-chip' + (type === 'suggestion' ? ' on' : '')}
              onClick={() => setType('suggestion')}
            >
              改进建议
            </div>
          </div>
        </div>

        <div className="field">
          <label htmlFor="fb-message">具体内容</label>
          <textarea
            id="fb-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={
              type === 'bug'
                ? '描述一下遇到了什么问题：做了什么操作、期望是什么、实际发生了什么'
                : '你想要的功能或改进是什么样的'
            }
            maxLength={5000}
            required
          />
          <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--fg-muted)' }}>
            {message.length} / 5000
          </div>
        </div>

        <div className="field">
          <label>截图（可选，最大 10 MB）</label>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={(e) => pickImage(e.target.files?.[0] ?? null)}
            style={{ fontSize: 13 }}
          />
          {preview && (
            <div style={{ marginTop: 10 }}>
              <img className="img-preview" src={preview} alt="预览" />
              <div style={{ marginTop: 6 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setImage(null)
                    if (fileRef.current) fileRef.current.value = ''
                  }}
                >
                  移除图片
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="field">
          <label htmlFor="fb-version">版本号（可选）</label>
          <input
            id="fb-version"
            type="text"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="如 2026.09.11.14"
            style={{ width: 200 }}
          />
        </div>

        {/* 蜜罐 —— 视觉移出屏幕，正常用户不会看到或填写 */}
        <div className="honeypot" aria-hidden="true">
          <label htmlFor="fb-website">网址</label>
          <input
            id="fb-website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={trap}
            onChange={(e) => setTrap(e.target.value)}
          />
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          disabled={!message.trim() || sending}
          style={{ padding: '9px 28px' }}
        >
          {sending ? '提交中…' : '提交反馈'}
        </button>
      </form>
    </div>
  )
}
