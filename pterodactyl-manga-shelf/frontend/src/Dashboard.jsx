import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Search, Plus, Download, LogOut, BookOpen, Trash } from 'lucide-react';

export default function Dashboard({ user, onLogout }) {
  const [mangas, setMangas] = useState([]);
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  useEffect(() => {
    fetchMangas();
  }, []);

  const fetchMangas = async () => {
    const res = await fetch('/api/mangas');
    if (res.ok) setMangas(await res.json());
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!newTitle) return;
    const res = await fetch('/api/mangas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle, status: 'Laufend' })
    });
    if (res.ok) {
      setNewTitle('');
      setShowAdd(false);
      fetchMangas();
    }
  };

  const filtered = mangas.filter(m => m.title.toLowerCase().includes(search.toLowerCase()) || m.author?.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <header className="flex flex-col sm:flex-row justify-between items-center mb-8 gap-4">
        <div className="flex items-center gap-3">
          <BookOpen className="w-8 h-8 text-brand-500" />
          <h1 className="text-3xl font-bold">Manga Shelf</h1>
        </div>
        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <Search className="absolute left-3 top-2.5 w-5 h-5 text-gray-500" />
            <input type="text" placeholder="Search..." className="input-field pl-10" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button onClick={() => setShowAdd(true)} className="btn-primary flex items-center gap-2"><Plus className="w-5 h-5" /> New</button>
          {user.role === 'admin' && (
            <a href="/api/backup" className="btn-secondary flex items-center gap-2" download><Download className="w-5 h-5" /> Backup</a>
          )}
          <button onClick={onLogout} className="btn-secondary p-2" title="Logout"><LogOut className="w-5 h-5" /></button>
        </div>
      </header>

      {showAdd && (
        <div className="glass-panel p-6 rounded-xl mb-8 animate-fade-in">
          <h2 className="text-xl font-bold mb-4">Add New Manga</h2>
          <form onSubmit={handleAdd} className="flex gap-4">
            <input type="text" placeholder="Manga Title" className="input-field flex-1" autoFocus value={newTitle} onChange={e => setNewTitle(e.target.value)} />
            <button type="submit" className="btn-primary">Create</button>
            <button type="button" onClick={() => setShowAdd(false)} className="btn-secondary">Cancel</button>
          </form>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-6">
        {filtered.map(manga => (
          <Link to={`/manga/${manga.id}`} key={manga.id} className="group relative glass-panel rounded-xl overflow-hidden hover:ring-2 hover:ring-brand-500 transition-all hover:-translate-y-1 block">
            <div className="aspect-[2/3] bg-gray-800 relative">
              {manga.cover_image ? (
                <img src={manga.cover_image} alt={manga.title} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center text-gray-600">
                  <BookOpen className="w-12 h-12 mb-2" />
                  <span className="text-sm">No Cover</span>
                </div>
              )}
              <div className="absolute top-2 right-2 bg-black/70 px-2 py-1 rounded text-xs font-bold backdrop-blur-sm">
                {manga.owned_volumes} / {manga.total_volumes || '?'}
              </div>
            </div>
            <div className="p-4">
              <h3 className="font-bold truncate" title={manga.title}>{manga.title}</h3>
              <p className="text-xs text-gray-400 truncate">{manga.author || 'Unknown Author'}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
