const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');

module.exports = {
  entry: './src/app.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js',
  },
  mode: 'development',
  devServer: {
    static: {
      directory: path.join(__dirname, 'public'),
    },
    compress: true,
    port: 8080,
    hot: true,
    open: true,
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/index.html',
      filename: 'index.html',
    }),
    new HtmlWebpackPlugin({
      template: './src/interview.html',
      filename: 'interview.html',
    }),
    new HtmlWebpackPlugin({
      template: './src/recruiter.html',
      filename: 'recruiter.html',
      chunks: [], // Don't inject bundle.js - recruiter.html has its own inline script
    }),
    new HtmlWebpackPlugin({
      template: './src/recruiter-login.html',
      filename: 'recruiter-login.html',
      chunks: [], // Standalone page with inline script
    }),
    new HtmlWebpackPlugin({
      template: './src/result.html',
      filename: 'result.html',
      chunks: [], // Standalone candidate thank-you page
    }),
    new HtmlWebpackPlugin({
      template: './src/jobs.html',
      filename: 'jobs.html',
      chunks: [],
    }),
    new HtmlWebpackPlugin({
      template: './src/job-detail.html',
      filename: 'job-detail.html',
      chunks: [],
    }),
    new HtmlWebpackPlugin({
      template: './src/seeker-login.html',
      filename: 'seeker-login.html',
      chunks: [],
    }),
    new HtmlWebpackPlugin({
      template: './src/seeker-reset-password.html',
      filename: 'seeker-reset-password.html',
      chunks: [],
    }),
    new HtmlWebpackPlugin({
      template: './src/seeker-apply.html',
      filename: 'seeker-apply.html',
      chunks: [],
    }),
    new HtmlWebpackPlugin({
      template: './src/seeker-applications.html',
      filename: 'seeker-applications.html',
      chunks: [],
    }),
    new HtmlWebpackPlugin({
      template: './src/seeker-profile.html',
      filename: 'seeker-profile.html',
      chunks: [],
    }),
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser',
    }),
  ],
  resolve: {
    extensions: ['.js'],
    fallback: {
      stream: require.resolve('stream-browserify'),
      buffer: require.resolve('buffer/'),
      util: require.resolve('util/'),
      crypto: require.resolve('crypto-browserify'),
      process: require.resolve('process/browser'),
    },
  },
};
