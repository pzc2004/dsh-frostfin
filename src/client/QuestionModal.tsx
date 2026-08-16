/**
 * M7 问题模态框：kimi 的 AskUserQuestion 在这里真正渲染成多选按钮。
 * 轮询 /plugins/frostfin/pending-questions?sessionId=（1.5 秒），有待答问题时
 * 弹出遮罩模态框；作答 POST 回 /plugins/frostfin/answer-question。
 * 挂在 conversation.composer.dock 槽位（与状态条同槽，无待答时渲染 null）。
 *
 * 语义对齐 kimi：Skip（reject_once 选项）= 用户跳过，模型改用文本追问；
 * 不做"关闭即默认选择"——绝不伪造用户没给过的答案。
 */
import { useEffect, useState } from 'react'

interface PendingQuestionOption {
  optionId: string
  name: string
  kind?: string
  description?: string
}

interface PendingQuestion {
  id: string
  sessionId: string
  question: string
  options: PendingQuestionOption[]
  createdAt: string
}

const styles = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(0, 0, 0, 0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  } as const,
  card: {
    maxWidth: 520, width: '90%', maxHeight: '80vh', overflow: 'auto',
    background: '#1e1f24', color: '#e6e6e9',
    border: '1px solid rgba(128,128,128,0.35)', borderRadius: 12,
    padding: '18px 20px', boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
  } as const,
  header: { fontSize: 12, opacity: 0.6, marginBottom: 8 } as const,
  question: { whiteSpace: 'pre-wrap', marginBottom: 16, lineHeight: 1.6 } as const,
  option: {
    display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
    padding: '8px 12px', marginBottom: 8, borderRadius: 8,
    border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit',
  } as const,
  desc: { fontSize: 12, opacity: 0.6, marginTop: 2 } as const,
  skip: { opacity: 0.65 } as const,
}

/** kimi 的 Skip 选项（reject_once）界面文案中文化；optionId 原样回传，不动语义。 */
function optionLabel(option: PendingQuestionOption): string {
  if (option.kind === 'reject_once' && option.name === 'Skip') return '跳过'
  return option.name
}

export function QuestionModal({ sessionId }: { sessionId: string }) {
  const [pending, setPending] = useState<PendingQuestion[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let stopped = false
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`/plugins/frostfin/pending-questions?sessionId=${encodeURIComponent(sessionId)}`)
        const data = await res.json() as { questions: PendingQuestion[] }
        if (!stopped) setPending(data.questions)
      } catch {
        // 端点暂时不可达（重启中）：保持上一次快照。
      }
    }
    void load()
    const timer = setInterval(() => void load(), 1500)
    return () => { stopped = true; clearInterval(timer) }
  }, [sessionId])

  const current = pending[0]
  if (current === undefined) return null

  const answer = async (optionId: string): Promise<void> => {
    setBusy(true)
    try {
      const res = await fetch('/plugins/frostfin/answer-question', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: current.id, optionId }),
      })
      if (res.ok) {
        // 作答成功：本地先摘除（下次轮询会带上后端的真实状态）。
        setPending(list => list.filter(item => item.id !== current.id))
      }
    } catch {
      // 网络抖动：留在原地，下次轮询重试。
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={styles.overlay}>
      <div style={styles.card}>
        <div style={styles.header}>Kimi 在等你作答</div>
        <div style={styles.question}>{current.question}</div>
        {current.options.map(option => (
          <button
            key={option.optionId}
            disabled={busy}
            style={{
              ...styles.option,
              ...(option.kind === 'reject_once' || option.kind === 'reject_always' ? styles.skip : {}),
              opacity: busy ? 0.5 : (option.kind === 'reject_once' || option.kind === 'reject_always' ? 0.65 : 1),
            }}
            onClick={() => void answer(option.optionId)}
          >
            {optionLabel(option)}
            {option.description !== undefined && <div style={styles.desc}>{option.description}</div>}
          </button>
        ))}
      </div>
    </div>
  )
}
