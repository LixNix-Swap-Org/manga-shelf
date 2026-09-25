import { useState } from 'react';
import { Book, User, Lock } from 'lucide-react';

export default function Setup({ onComplete }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (res.ok) {
      onComplete();
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="glass-panel p-8 rounded-2xl w-full max-w-md animate-fade-in">
        <div className="text-center mb-8">
          <div className="mx-auto bg-brand-500/20 w-16 h-16 rounded-full flex items-center justify-center mb-4">
            <Book className="w-8 h-8 text-brand-500" />
          </div>
          <h1 className="text-2xl font-bold">Welcome to Manga Shelf</h1>
          <p className="text-gray-400 mt-2">Create your admin account to get started</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Username</label>
            <div className="relative">
              <User className="absolute left-3 top-2.5 w-5 h-5 text-gray-500" />
              <input type="text" className="input-field pl-10" required value={username} onChange={e => setUsername(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-2.5 w-5 h-5 text-gray-500" />
              <input type="password" className="input-field pl-10" required value={password} onChange={e => setPassword(e.target.value)} />
            </div>
          </div>
          <button type="submit" className="btn-primary w-full mt-6">Create Admin Account</button>
        </form>
      </div>
    </div>
  );
}
