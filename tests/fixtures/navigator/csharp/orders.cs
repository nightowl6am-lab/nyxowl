using System;

namespace Orders
{
    public interface IProcessor
    {
        void Process();
    }

    public enum Status
    {
        New,
        Done,
    }

    public struct Money
    {
        public decimal Amount;
    }

    public record Order(int Id);

    public class OrderService : IProcessor
    {
        private int count;

        public OrderService(int count)
        {
            this.count = count;
        }

        public void Process()
        {
        }

        protected void Helper()
        {
        }

        private void Hidden()
        {
        }

        internal void Internal()
        {
        }

        public int Count => count;

        public int Double(int x) => x * 2;

        public class Nested
        {
            public void Run()
            {
            }
        }
    }

    public class Arrow
    {
        public int Triple(int x) => x * 3;
    }
}
