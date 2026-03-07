import React from 'react';
import { Article } from 'core';

interface Props {
    synopsis: string;
    setSynopsis: (val: string) => void;
    articles: Article[];
    onRemoveArticle: (id: string) => void;
    onSaveDraft: () => void;
    isSaving: boolean;
}

export const DraftEditor: React.FC<Props> = ({
    synopsis,
    setSynopsis,
    articles,
    onRemoveArticle,
    onSaveDraft,
    isSaving
}) => {
    return (
        <div className="flex-1 flex flex-col bg-white overflow-hidden relative">
            {/* Editor Header */}
            <div className="p-8 border-b border-slate-100 shrink-0">
                <h1 className="text-3xl font-black text-slate-900 tracking-tight mb-2">Weekly Recap Draft</h1>
                <p className="text-slate-500 font-medium">Refine your synopsis and curate up to 5 standard top articles for your email newsletter.</p>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-8 space-y-12">
                {/* Journalist Synopsis Section */}
                <section>
                    <div className="flex justify-between items-end mb-4">
                        <label className="text-xs font-black text-slate-400 uppercase tracking-widest italic">Journalist Synopsis</label>
                        <span className="text-[10px] text-slate-300 font-bold">{synopsis.length} characters</span>
                    </div>
                    <textarea
                        className="w-full h-48 p-6 bg-slate-50 border border-slate-200 rounded-2xl text-slate-800 placeholder-slate-300 focus:outline-none focus:ring-4 focus:ring-slate-100 focus:bg-white focus:border-slate-300 transition-all text-lg leading-relaxed shadow-[inset_0_2px_4px_rgba(0,0,0,0.02)]"
                        placeholder="Start writing your insightful breakdown of this week's news..."
                        value={synopsis}
                        onChange={(e) => setSynopsis(e.target.value)}
                    />
                </section>

                {/* Selected Articles List */}
                <section>
                    <div className="flex justify-between items-center mb-6">
                        <label className="text-xs font-black text-slate-400 uppercase tracking-widest italic">Selected Articles ({articles.length} / 5)</label>
                    </div>

                    {articles.length === 0 ? (
                        <div className="py-12 px-6 border-2 border-dashed border-slate-100 rounded-2xl text-center">
                            <p className="text-slate-400 font-medium mb-1">No articles selected yet.</p>
                            <p className="text-[10px] text-slate-300 font-bold uppercase tracking-widest">Search headlines in the sidebar and click &quot;Add&quot;</p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {articles.map((article, idx) => (
                                <div key={article.id} className="flex gap-6 p-6 bg-slate-50 rounded-2xl border border-slate-200 shadow-sm items-start relative group transition-all hover:bg-white hover:border-slate-300">
                                    <div className="h-10 w-10 shrink-0 bg-slate-900 text-white rounded-full flex items-center justify-center font-black text-sm shadow-lg">
                                        {idx + 1}
                                    </div>
                                    <div className="flex-1 pr-8">
                                        <h4 className="font-bold text-slate-900 mb-2 text-lg">
                                            {article.title}
                                        </h4>
                                        <p className="text-sm text-slate-500 line-clamp-2 leading-relaxed mb-3">
                                            {article.snippet && article.snippet !== "No description available" ? article.snippet : "Description will be pulled automatically for final mailing."}
                                        </p>
                                        <a href={article.link} target="_blank" rel="noopener noreferrer" className="text-xs font-bold text-blue-600 hover:text-blue-800 break-all underline-offset-4 hover:underline">
                                            {article.link}
                                        </a>
                                    </div>
                                    <button
                                        onClick={() => onRemoveArticle(article.id)}
                                        className="absolute top-4 right-4 p-2 text-slate-300 hover:text-red-500 transition-colors"
                                        title="Remove from draft"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
};
