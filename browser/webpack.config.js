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