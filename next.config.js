module.exports = {
  async redirects() {
    return [
      {
        source: '/tx',
        destination: '/',
        permanent: true,
      },
    ];
  },
};
