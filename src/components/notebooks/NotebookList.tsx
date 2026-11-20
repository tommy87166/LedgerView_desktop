import { confirm, open } from '@tauri-apps/plugin-dialog';
import { useMessages } from '../../i18n';
import { request } from '../../lib/native';
import { addNotebook, deleteNotebook, selectNotebook, useNotebooks } from '../../store/notebooks';
import { useUi } from '../../store/ui';
import { IconNotebook } from '../common/icons';

export function NotebookList({ onNavigate }: { onNavigate: () => void }) {
  const t = useMessages();
  const { books, activeId, editing } = useNotebooks();
  const toast = useUi((s) => s.toast);
  const create = async () => {
    try {
      const book = await request('createNotebook', { cellName: t.notebook.cell + ' 1' });
      onNavigate();
      addNotebook(book);
    } catch (err) {
      toast('error', String(err));
    }
  };
  const openFile = async () => {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: t.notebook.fileType, extensions: ['json'] }],
      });
      if (!path) return;
      const book = await request('openNotebook', { path });
      onNavigate();
      addNotebook(book);
    } catch (err) {
      toast('error', t.notebook.openError + ' · ' + String(err));
    }
  };
  const remove = async (id: string, name: string) => {
    try {
      if (await confirm(t.notebook.delConfirm + ' ' + name)) await deleteNotebook(id);
    } catch (err) {
      toast('error', String(err));
    }
  };
  return (
    <section aria-labelledby="notebooks-heading">
      <div className="sidebar-section-head">
        <h2 id="notebooks-heading">
          <button
            className="notebook-section-link"
            onClick={() => {
              onNavigate();
              selectNotebook(activeId);
            }}
          >
            {t.notebook.title}
          </button>
        </h2>
        <div className="sidebar-section-actions">
          <button
            className="open-source"
            aria-label={t.notebook.create}
            onClick={() => void create()}
          >
            {t.notebook.newBook}
          </button>
          <button
            className="open-source"
            aria-label={t.notebook.open}
            onClick={() => void openFile()}
          >
            {t.sidebar.open}
          </button>
        </div>
      </div>
      {books.map((book) => (
        <div
          key={book.id}
          className={'source-row' + (editing && activeId === book.id ? ' selected' : '')}
        >
          <button
            className="item-name"
            onClick={() => {
              onNavigate();
              selectNotebook(book.id);
            }}
            aria-current={editing && activeId === book.id ? 'true' : undefined}
            title={book.name}
          >
            <IconNotebook />
            <span>{book.name}</span>
          </button>
          <button
            className="quiet-button close-source"
            aria-label={t.notebook.delete + ' · ' + book.name}
            title={t.notebook.delete}
            onClick={() => void remove(book.id, book.name)}
          >
            ×
          </button>
        </div>
      ))}
    </section>
  );
}
