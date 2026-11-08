const GROUPS: [string, [string, string][]][] = [
  [
    'Anywhere',
    [
      ['?', 'Show this list'],
      ['/  or  ⌘K', 'Search all sessions'],
      ['⌘1 · ⌘2 · ⌘3', 'Focus chats · trace · detail'],
      ['⌥↓ · ⌥↑', 'Next · previous chat'],
      ['Esc', 'Close dialog or find bar'],
    ],
  ],
  [
    'Chat list',
    [
      ['↓ ↑  or  j k', 'Move (opens the chat)'],
      ['→ ←  or  l h  ·  Space', 'Unfold · fold project'],
      ['m', 'Show 4 more chats'],
      ['Enter', 'Go to the trace'],
      ['↓ in search', 'Go to the results'],
    ],
  ],
  [
    'Trace',
    [
      ['↓ ↑  or  j k', 'Move'],
      ['→ ←  or  l h  ·  Space', 'Expand · collapse step'],
      ['g · G · PgDn · PgUp', 'First · last · page'],
      ['Enter', 'Go to the detail'],
      ['c · s · i · f', 'Collapse all · stats · context · follow'],
    ],
  ],
  [
    'Detail',
    [
      ['j k  or  ↓ ↑', 'Scroll'],
      ['Esc  or  h', 'Back to the trace'],
    ],
  ],
  [
    'Find in session',
    [
      ['⌘F', 'Open'],
      ['Enter · ⇧Enter', 'Next · previous match'],
      ['⌘G · ⇧⌘G', 'Next · previous match'],
    ],
  ],
];

export function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Keyboard shortcuts</h2>
          <button onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </header>
        <div className="shortcut-grid">
          {GROUPS.map(([title, rows]) => (
            <section key={title}>
              <h3>{title}</h3>
              <table>
                <tbody>
                  {rows.map(([k, what]) => (
                    <tr key={k}>
                      <td>
                        <kbd>{k}</kbd>
                      </td>
                      <td>{what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
