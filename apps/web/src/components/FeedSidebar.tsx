import React, { useState, useEffect } from 'react';
import { Article } from 'core';

interface Props {
    onAddArticle: (article: Article) => void;
}

export const FeedSidebar: React.FC<Props> = ({ onAddArticle }) => {
    const [source, setSource] = useState<'yahoo' | 'bloomberg'>('yahoo');
    const [query, setQuery] = useState('');
    const [articles, setArticles] = useState<Article[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        let active = true;
        setLoading(true);
        fetch(`http://localhost:31415/api/feeds?source=${source}`)
            .then(res => res.json())
            .then(data => {
                if (active) {
                    setArticles(Array.isArray(data) ? data : []);
                    setLoading(false);
                }
            })
            .catch(err => {
                console.error(err);
                if (active) setLoading(false);
            });
        return () => { active = false; };
    }, [source]);

    const filteredArticles = articles.filter(a =>
        a.title.toLowerCase().includes(query.toLowerCase()) ||
        a.snippet.toLowerCase().includes(query.toLowerCase())
    );

    return (
        <div className="w-1/3 bg-white border-r border-gray-200 flex flex-col h-full overflow-hidden shadow-sm">
            <div className="p-4 border-b border-gray-200">
                <h2 className="text-xl font-bold text-gray-800 mb-4">News Feeds</h2>

                <div className="flex gap-2 mb-4 bg-gray-100 p-1 rounded-lg">
                    <button
                        className={`flex-1 py-1.5 rounded-md font-medium text-sm transition-colors ${source === 'yahoo' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-600 hover:bg-gray-200'}`}
                        onClick={() => setSource('yahoo')}
                    >
                        Yahoo
                    </button>
                    <button
                        className={`flex-1 py-1.5 rounded-md font-medium text-sm transition-colors ${source === 'bloomberg' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-600 hover:bg-gray-200'}`}
                        onClick={() => setSource('bloomberg')}
                    >
                        Bloomberg
                    </button>
                </div>

                <input
                    type="text"
                    placeholder="Search headlines..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50">
                {loading ? (
                    <div className="animate-pulse flex flex-col items-center justify-center h-48 text-gray-500">
                        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mb-2"></div>
                        Loading...
                    </div>
                ) : filteredArticles.length === 0 ? (
                    <p className="text-center text-gray-500 py-8">No articles found.</p>
                ) : (
                    filteredArticles.map(article => (
                        <div key={article.id} className="bg-white p-4 rounded-lg shadow-sm border border-gray-200 transition-shadow hover:shadow-md">
                            <h3 className="font-semibold text-gray-800 mb-2 leading-tight">
                                <a href={article.link} target="_blank" rel="noopener noreferrer" className="hover:text-blue-600 hover:underline">
                                    {article.title}
                                </a>
                            </h3>
                            <p className="text-sm text-gray-600 line-clamp-2 mb-3">{article.snippet}</p>
                            <div className="flex justify-between items-center mt-2">
                                <span className="text-xs text-gray-400 font-medium uppercase tracking-wider">
                                    {new Date(article.pubDate).toLocaleDateString()}
                                </span>
                                <button
                                    onClick={() => onAddArticle(article)}
                                    className="px-3 py-1.5 bg-blue-50 text-blue-600 text-sm font-medium rounded hover:bg-blue-100 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                                >
                                    Add to Auth
                                </button>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};
