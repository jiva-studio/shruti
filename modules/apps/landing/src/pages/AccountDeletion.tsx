import React from 'react';
import NavBar from "@/components/NavBar";
import Footer from "@/components/Footer";

const AccountDeletion = () => {
  return (
    <div className="min-h-screen flex flex-col">
      <NavBar />
      <main className="flex-grow pt-24 pb-16">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-bold text-sadu-dark-purple mb-6">Account Deletion & Data Policy</h1>
          
          <div className="prose prose-purple max-w-none">
            <p className="text-gray-700 mb-4">Last updated: May 10, 2025</p>
            
            <h2 className="text-xl font-semibold text-sadu-dark-purple mt-8 mb-4">🧘 How to Delete Your Account</h2>
            <p className="text-gray-700 mb-4">
              To delete your account, you have two options:
            </p>
            
            <div className="bg-gray-50 rounded-lg p-6 mb-6">
              <h3 className="text-lg font-medium text-sadu-dark-purple mb-3">Option 1: Using the App</h3>
              <ol className="list-decimal pl-6 text-gray-700 space-y-2">
                <li>Open the <strong>Shruti</strong> app</li>
                <li>Go to <strong>Settings &gt; Tap to your Account &gt; Delete Account</strong></li>
                <li>Confirm the deletion in modal dialog (Press and hold Delete button)</li>
                <li>Your account will be permanently deleted immediately</li>
              </ol>
            </div>
            
            <div className="bg-gray-50 rounded-lg p-6 mb-6">
              <h3 className="text-lg font-medium text-sadu-dark-purple mb-3">Option 2: Email Request</h3>
              <p className="text-gray-700">
                You can email us at <a href="mailto:contact@akdasa.studio?subject=Delete My Account" className="text-sadu-purple hover:underline">contact@akdasa.studio</a> with the subject <strong>"Delete My Account"</strong>.
              </p>
            </div>
            
            <h2 className="text-xl font-semibold text-sadu-dark-purple mt-8 mb-4">🔐 What Happens to Your Data</h2>
            <p className="text-gray-700 mb-4">
              When you delete your account, we take the following actions with your data:
            </p>
            
            <div className="bg-red-50 border-l-4 border-red-400 p-6 mb-6">
              <h3 className="text-lg font-medium text-red-800 mb-3">We Permanently Delete:</h3>
              <ul className="list-disc pl-6 text-red-700 space-y-1">
                <li>Your user profile and login credentials</li>
                <li>Saved playlists and listening history</li>
                <li>Saved notes</li>
                <li>Any personal preferences or app settings</li>
              </ul>
            </div>
            
            <div className="bg-yellow-50 border-l-4 border-yellow-400 p-6 mb-6">
              <h3 className="text-lg font-medium text-yellow-800 mb-3">We Retain:</h3>
              <ul className="list-disc pl-6 text-yellow-700 space-y-1">
                <li>Anonymous usage statistics (not linked to your identity)</li>
                <li>Purchase records (as required by law or financial reporting regulations) — retained for up to <strong>5 years</strong></li>
              </ul>
            </div>
            
            <h2 className="text-xl font-semibold text-sadu-dark-purple mt-8 mb-4">📌 Retention Period</h2>
            <p className="text-gray-700 mb-4">
              If required by law or for fraud prevention, we may retain certain records for a limited time, even after account deletion. 
              This is done in compliance with applicable legal requirements and industry standards.
            </p>
            
            <p className="text-gray-700 mb-4">
              For more details about how we handle your data, please see our <a href="/policy" className="text-sadu-purple hover:underline">Privacy Policy</a>.
            </p>
            
            <h2 className="text-xl font-semibold text-sadu-dark-purple mt-8 mb-4">Need Help?</h2>
            <p className="text-gray-700 mb-4">
              If you have any questions about account deletion or our data practices, please don't hesitate to contact us at <a href="mailto:contact@akdasa.studio" className="text-sadu-purple hover:underline">contact@akdasa.studio</a>.
            </p>
            
            <div className="bg-blue-50 border-l-4 border-blue-400 p-6 mt-8">
              <p className="text-blue-800">
                <strong>Important:</strong> Account deletion is permanent and cannot be undone. Please make sure you've backed up any important data before proceeding.
              </p>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default AccountDeletion;
