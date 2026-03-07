/**
 * @file overview
 * The root Application component for the Weekly Recap Newsletter frontend.
 * This component will eventually host the WYSIWYG editor, the dynamic
 * feed views for Yahoo/Bloomberg, and the template preview layout.
 */

import React, { useState } from 'react';
import { Article } from 'core';
import { FeedSidebar } from './components/FeedSidebar';
import { DraftEditor } from './components/DraftEditor';
import { ExportModal } from './components/ExportModal';

/**
 * Functional component `App`.
 * Renders the main structural layout of the application.
 * 
 * @returns {JSX.Element} The rendered React tree for the application stub.
 */
function App() {
    const [synopsis, setSynopsis] = useState('');
    const [selectedArticles, setSelectedArticles] = useState<Article[]>([]);

    const handleAddArticle = (article: Article) => {
        if (selectedArticles.length >= 5) {
            alert("You can only select up to 5 articles for the weekly recap.");
            return;
        }
        if (selectedArticles.find(a => a.id === article.id)) {
            return; // already added
        }
        setSelectedArticles([...selectedArticles, article]);
    };

    const handleRemoveArticle = (id: string) => {
        setSelectedArticles(selectedArticles.filter(a => a.id !== id));
    };

    return (
        <div className="flex bg-gray-100 font-sans" style={{ height: '100vh', overflow: 'hidden' }}>
            <FeedSidebar onAddArticle={handleAddArticle} />
            <DraftEditor
                synopsis={synopsis}
                setSynopsis={setSynopsis}
                articles={selectedArticles}
                onRemoveArticle={handleRemoveArticle}
            />
            <ExportModal synopsis={synopsis} articles={selectedArticles} />
        </div>
    );
}

export default App;
