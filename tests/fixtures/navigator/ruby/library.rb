require "json"

module Library
  class Book
    def initialize(title)
      @title = title
    end

    def public_method
      "public"
    end

    private

    def secret
      "secret"
    end

    protected

    def guarded
      "guarded"
    end

    public

    def visible_again
      "visible"
    end

    class Nested
      def nested_method
        "nested"
      end
    end
  end
end

def top_level
  "top"
end

class Standalone
  def self.build
    new
  end
end

def self.module_helper
  "module"
end
