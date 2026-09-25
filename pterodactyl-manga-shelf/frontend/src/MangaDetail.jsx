import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Edit, Image as ImageIcon, Check, Plus } from 'lucide-react';

export default function MangaDetail({ user }) {
  const { id } = useParams();
  const [manga, setManga] = useState(null);
  const [editing, setEditing] = useState(false);
  const [formData, setFormData] = useState({});
  const [newVolume, setNewVolume] = useState('');

  useEffect(() => {
    fetchManga();
  }, [id]);

  const fetchManga = async () => {
    const res = await fetch(`/api/mangas/${id}`);
    if (res.ok) {
      const data = await res.json();
      setManga(data);
      setFormData(data);
    }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    await fetch(`/api/mangas/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData)
    });
    setEditing(false);
    fetchManga();
  };

  const handleCoverUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('image', file);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    if (res.ok) {
      const data = await res.json();
      setFormData({ ...formData, cover_image: data.url });
      await fetch(`/api/mangas/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...formData, cover_image: data.url })
      });
      fetchManga();
    }
  };

  const addVolume = async () => {
    if (!newVolume) return;
    await fetch('/api/volumes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manga_id: id, volume_number: newVolume, status: 'Vorhanden' })
    });
    setNewVolume('');
    fetchManga();
  };

  const toggleVolumeStatus = async (vol) => {
    const newStatus = vol.status === 'Vorhanden' ? 'Fehlt' : 'Vorhanden';
    await fetch(`/api/volumes/${vol.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...vol, status: newStatus })
    });
    fetchManga();
  };

  if (!manga) return <div className="p-8">Loading...</div>;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Link to="/" className="inline-flex items-center gap-2 text-brand-500 hover:text-brand-400 mb-6 font-medium">
        <ArrowLeft className="w-5 h-5" /> Back to Shelf
      </Link>

      <div className="glass-panel p-6 rounded-2xl flex flex-col md:flex-row gap-8 mb-8">
        <div className="w-full md:w-64 shrink-0">
          <label className="block relative aspect-[2/3] bg-gray-800 rounded-xl overflow-hidden cursor-pointer group shadow-2xl">
            {manga.cover_image ? (
              <img src={manga.cover_image} alt="Cover" className="w-full h-full object-cover group-hover:opacity-50 transition-opacity" />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-gray-600">
                <ImageIcon className="w-12 h-12 mb-2" />
                <span>Upload Cover</span>
              </div>
            )}
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/50">
              <span className="bg-brand-600 px-3 py-1 rounded-full text-sm font-medium">Change Cover</span>
            </div>
            <input type="file" accept="image/*" className="hidden" onChange={handleCoverUpload} />
          </label>
        </div>

        <div className="flex-1">
          {editing ? (
            <form onSubmit={handleUpdate} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div><label className="text-sm text-gray-400">Title</label><input type="text" className="input-field" value={formData.title} onChange={e=>setFormData({...formData, title: e.target.value})} /></div>
                <div><label className="text-sm text-gray-400">Author</label><input type="text" className="input-field" value={formData.author || ''} onChange={e=>setFormData({...formData, author: e.target.value})} /></div>
                <div><label className="text-sm text-gray-400">Publisher</label><input type="text" className="input-field" value={formData.publisher || ''} onChange={e=>setFormData({...formData, publisher: e.target.value})} /></div>
                <div><label className="text-sm text-gray-400">Total Volumes</label><input type="number" className="input-field" value={formData.total_volumes || ''} onChange={e=>setFormData({...formData, total_volumes: e.target.value})} /></div>
              </div>
              <div><label className="text-sm text-gray-400">Description</label><textarea className="input-field h-24" value={formData.description || ''} onChange={e=>setFormData({...formData, description: e.target.value})}></textarea></div>
              <div className="flex gap-2">
                <button type="submit" className="btn-primary">Save</button>
                <button type="button" onClick={() => setEditing(false)} className="btn-secondary">Cancel</button>
              </div>
            </form>
          ) : (
            <div>
              <div className="flex justify-between items-start">
                <div>
                  <h1 className="text-4xl font-bold mb-2">{manga.title}</h1>
                  <p className="text-lg text-gray-400 mb-4">{manga.author}</p>
                </div>
                <button onClick={() => setEditing(true)} className="btn-secondary flex items-center gap-2"><Edit className="w-4 h-4" /> Edit</button>
              </div>
              <div className="flex gap-4 text-sm mb-6">
                <span className="bg-gray-800 px-3 py-1 rounded-full text-brand-400 border border-brand-500/30">{manga.publisher || 'No Publisher'}</span>
                <span className="bg-gray-800 px-3 py-1 rounded-full text-green-400 border border-green-500/30">{manga.status}</span>
                <span className="bg-gray-800 px-3 py-1 rounded-full">Total: {manga.total_volumes || '?'}</span>
              </div>
              <p className="text-gray-300 leading-relaxed max-w-3xl">{manga.description || 'No description provided.'}</p>
            </div>
          )}
        </div>
      </div>

      <div className="glass-panel p-6 rounded-2xl">
        <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">Volumes Checklist</h2>
        <div className="flex flex-wrap gap-3 mb-6">
          {manga.volumes.map(vol => (
            <button 
              key={vol.id} 
              onClick={() => toggleVolumeStatus(vol)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${vol.status === 'Vorhanden' ? 'bg-green-500/20 text-green-400 border border-green-500/50 hover:bg-green-500/30' : 'bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700'}`}
            >
              {vol.status === 'Vorhanden' && <Check className="w-4 h-4" />}
              Vol. {vol.volume_number}
            </button>
          ))}
        </div>

        <div className="flex gap-3 max-w-sm">
          <input type="text" placeholder="Vol. number" className="input-field" value={newVolume} onChange={e => setNewVolume(e.target.value)} onKeyDown={e => e.key === 'Enter' && addVolume()} />
          <button onClick={addVolume} className="btn-primary flex items-center gap-2"><Plus className="w-5 h-5" /> Add</button>
        </div>
      </div>
    </div>
  );
}
